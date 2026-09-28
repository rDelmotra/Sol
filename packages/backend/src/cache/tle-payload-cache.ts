import zlib from 'node:zlib';
import { readRawTleCache, readVersion } from './file-cache.js';
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
// ============================================================

export interface TlePayload {
  version: string;
  etag: string;
  count: number;
  gzip: Buffer;
}

let cached: TlePayload | null = null;

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
): { etag: string; gzip: Buffer } {
  const envelope = `{"version":${JSON.stringify(version)},"count":${count},"data":${rawArray}}`;
  const gzip = zlib.gzipSync(Buffer.from(envelope, 'utf8'), { level: 9 });
  return { etag: `"${version}"`, gzip };
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
    const { etag, gzip } = buildTlePayload(raw, v.version, v.count);
    cached = { version: v.version, etag, count: v.count, gzip };
    return cached;
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
