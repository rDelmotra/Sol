import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { readRawTleCache, readVersion } from './file-cache.js';
import { tleBrotliEnabled, tleBrotliQuality } from '../utils/config.js';
import type { ServedEncoding } from '../utils/http-encoding.js';
import { logger } from '../utils/logger.js';

// ============================================================
// In-memory, pre-gzipped /api/tle/all payload cache
//
// The TLE dataset changes once a day (cron at 02:00 UTC + on-boot fetch), yet
// the old handler re-read 13.8 MB from disk, parsed it, re-serialized it, and
// gzipped it ON EVERY REQUEST. This module builds the gzipped response body
// ONCE per data version and holds it in memory, keyed on the version string
// from version.json.
//
// Build strategy: the disk file is already a JSON array, so we splice it into
// the response envelope by string concat — no JSON.parse / JSON.stringify of
// the 13.8 MB payload. gzip is level 9 (smaller download; cost paid once).
//
// Brotli: a second, smaller copy is built in the background with the async
// zlib.brotliCompress (libuv threadpool, so the event loop is never blocked).
// The gzip copy is ready at once; `br` stays null until the brotli job ends,
// and requests that arrive before then get gzip. Quality 10 with the default
// 4 MB window takes about 10 s and +50 MB RSS on a 26 MB catalog and is about
// 23% smaller than gzip 9. Switch off with TLE_BROTLI=0; tune with
// TLE_BROTLI_QUALITY (utils/config.ts).
// ============================================================

export interface TlePayload {
  version: string;
  /** ETag of the gzip copy (kept as `"<version>"` so validators cached before brotli existed still match). */
  etag: string;
  count: number;
  gzip: Buffer;
  /** Brotli copy; null until the background job finishes (or when disabled/failed). */
  br: Buffer | null;
}

let cached: TlePayload | null = null;
const brotliJobs = new Set<Promise<void>>();

const brotliCompress = promisify(zlib.brotliCompress);

/**
 * ETag for one representation. Each encoding gets its own tag so a 304 can
 * never make a client keep a body in the wrong encoding. gzip keeps the plain
 * `"<version>"` form (see TlePayload.etag).
 */
export function tleEtag(version: string, encoding: ServedEncoding): string {
  return encoding === 'gzip' ? `"${version}"` : `"${version}-${encoding}"`;
}

/**
 * Brotli-compress on the libuv threadpool (async: the event loop stays free).
 * SIZE_HINT lets the encoder size its buffers for the whole input up front.
 */
export function compressBrotli(input: Buffer, quality: number = tleBrotliQuality()): Promise<Buffer> {
  const c = zlib.constants;
  return brotliCompress(input, {
    params: {
      [c.BROTLI_PARAM_MODE]: c.BROTLI_MODE_TEXT,
      [c.BROTLI_PARAM_QUALITY]: quality,
      [c.BROTLI_PARAM_SIZE_HINT]: input.length,
    },
  });
}

/**
 * Build the gzipped /api/tle/all response body from the raw on-disk array
 * string. Pure (no disk/state) so it can be unit-tested directly.
 *
 * `rawArray` is the verbatim contents of tle-cache.json (a JSON array). The
 * emitted JSON is shape-identical to the old `res.json({version,count,data})`
 * — i.e. @orbitwatch/contracts' `CatalogResponse`. Deliberately NOT built via
 * an object literal + JSON.stringify (which would let us `satisfies
 * CatalogResponse` it): `rawArray` is spliced in as a raw string precisely to
 * avoid parsing/re-serializing the ~13.8 MB payload on every version change
 * (see the module comment above) — constructing an object here to satisfy the
 * type would reintroduce that cost. C3 note: this envelope was intentionally
 * left un-typed for that reason; the non-gzip fallback in routes/tle.ts and
 * history/serving/snapshot-cache.ts's per-day build (both cheap, object-based)
 * carry the `satisfies CatalogResponse` check instead.
 */
export function buildTlePayload(
  rawArray: string,
  version: string,
  count: number,
): { etag: string; gzip: Buffer; envelope: Buffer } {
  const envelope = Buffer.from(
    `{"version":${JSON.stringify(version)},"count":${count},"data":${rawArray}}`,
    'utf8',
  );
  const gzip = zlib.gzipSync(envelope, { level: 9 });
  return { etag: tleEtag(version, 'gzip'), gzip, envelope };
}

/**
 * Start the background brotli job for `payload`. The result is attached only if
 * `payload` is still the live cached one (a newer data version may have replaced
 * it while this ran). Never throws: on failure the payload simply stays gzip-only.
 */
function startBrotli(payload: TlePayload, envelope: Buffer): void {
  if (!tleBrotliEnabled()) return;
  const started = Date.now();
  const job: Promise<void> = compressBrotli(envelope)
    .then((br) => {
      if (cached !== payload) return; // superseded by a newer version: drop it
      payload.br = br;
      logger.info(
        `TLE brotli ready: ${(br.length / 1_048_576).toFixed(2)} MB ` +
          `(gzip ${(payload.gzip.length / 1_048_576).toFixed(2)} MB) in ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s, version=${payload.version}`,
      );
    })
    .catch((err) => {
      logger.error('TLE brotli build failed (serving gzip only):', err);
    })
    .finally(() => {
      brotliJobs.delete(job);
    });
  brotliJobs.add(job);
}

/** Resolves when every in-flight brotli job has finished. For tests and shutdown. */
export async function brotliSettled(): Promise<void> {
  await Promise.all([...brotliJobs]);
}

/**
 * Return the current pre-gzipped payload, rebuilding it only when the on-disk
 * version changes (or on first call). Returns null when no cache exists yet
 * (first boot before the initial fetch) — callers should 503 in that case.
 */
export function getTlePayload(): TlePayload | null {
  const v = readVersion();
  if (!v) return null;

  if (cached && cached.version === v.version) return cached;

  const raw = readRawTleCache();
  if (!raw) return null;

  try {
    const { etag, gzip, envelope } = buildTlePayload(raw, v.version, v.count);
    const payload: TlePayload = { version: v.version, etag, count: v.count, gzip, br: null };
    cached = payload;
    startBrotli(payload, envelope);
    return payload;
  } catch (err) {
    logger.error('Failed to build TLE payload cache:', err);
    return null;
  }
}

/**
 * Proactively warm the in-memory payload so no real request eats the one-time
 * rebuild. Called at startup (when the cache is already fresh) and after each
 * cron writeCache.
 */
export function primeTlePayload(): void {
  const payload = getTlePayload();
  if (payload) {
    logger.info(
      `TLE payload cache warmed: ${payload.count} objects, ` +
        `${(payload.gzip.length / 1_048_576).toFixed(2)} MB gzip, version=${payload.version}`,
    );
  }
}
