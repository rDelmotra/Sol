import fs from 'fs';
import path from 'path';
import { cacheDir } from '../utils/paths.js';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { VersionInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';

// ============================================================
// File-based cache
//
// Two files are maintained:
//   data/tle-cache.json   — full enriched TLE array (the large payload)
//   data/version.json     — lightweight metadata (version timestamp, count,
//                           byte size); clients poll this to decide if they
//                           need to refetch the full dataset.
//
// Cache TTL is 24 hours — Space-Track is the primary source and we must not
// hammer their API. CelesTrak (fallback) updates every 4–8 h but a 24h TTL
// is acceptable for orbital data at this scale.
// On startup the server checks the file mtime; if it is < CACHE_TTL_MS old
// the cache is considered fresh and no fetch is triggered.
// The daily cron uses a much shorter guard (CRON_MIN_AGE_MS) so it always
// refreshes; see shouldSkipRefresh.
// ============================================================

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// A scheduled (cron) refresh only skips when the cache is younger than this.
// It makes the cron safe against double-triggers and restart loops without
// letting the 24 h boot TTL swallow the daily run (cache written 02:00:13 is
// 23h59m48s old at the next 02:00:00 cron).
export const CRON_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour
export const VISUAL_CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export interface VisualNoradCache {
  version: string;
  ids: number[];
}

function getCacheDir(): string {
  return cacheDir();
}

function tleCachePath(): string {
  return path.join(getCacheDir(), 'tle-cache.json');
}

function versionPath(): string {
  return path.join(getCacheDir(), 'version.json');
}

function visualCachePath(): string {
  return path.join(getCacheDir(), 'visual-cache.json');
}

/** Ensure the cache directory exists. */
function ensureCacheDir(): void {
  fs.mkdirSync(getCacheDir(), { recursive: true });
}

function normalizeNoradIds(values: unknown[]): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      ids.add(value);
    }
  }
  return Array.from(ids).sort((a, b) => a - b);
}

// ============================================================
// Read helpers
// ============================================================

/** Age of the TLE cache file in ms (from mtime), or null if it does not exist. */
export function cacheAgeMs(now: number = Date.now()): number | null {
  const p = tleCachePath();
  if (!fs.existsSync(p)) return null;
  return now - fs.statSync(p).mtimeMs;
}

/** Why an update cycle is running: 'boot' = process start, 'cron' = the daily schedule. */
export type UpdateTrigger = 'boot' | 'cron';

/**
 * Pure policy: should an update cycle skip the fetch?
 *  - no cache (age null)  -> never skip
 *  - boot                 -> skip while the cache is inside the 24 h TTL
 *  - cron                 -> skip only if the cache is under CRON_MIN_AGE_MS
 *                            (a restart loop or double trigger must not hammer Space-Track,
 *                             but a normal daily run must always refresh)
 */
export function shouldSkipRefresh(
  ageMs: number | null,
  trigger: UpdateTrigger,
  ttlMs: number = CACHE_TTL_MS,
  cronMinAgeMs: number = CRON_MIN_AGE_MS,
): boolean {
  if (ageMs === null) return false;
  return ageMs < (trigger === 'cron' ? cronMinAgeMs : ttlMs);
}

/** A new catalog smaller than this share of the cached one is refused. */
export const MIN_CATALOG_RATIO = 0.5;

export interface CatalogVerdict {
  ok: boolean;
  /** One plain sentence. Goes into the log when the catalog is refused. */
  reason: string;
}

/**
 * Pure policy: may a freshly fetched catalog replace the cached one?
 *  - 0 objects                       -> never (Space-Track answers `200 []` on a
 *                                       bad day; a cut-off page list looks the same)
 *  - no cache, or an empty cache     -> any non-empty catalog (first boot, dev mode)
 *  - cache exists                    -> refused when it has fewer than `minRatio`
 *                                       (default 50%) of the cached object count
 * `cachedCount` is null when there is no readable cache.
 */
export function assessCatalog(
  newCount: number,
  cachedCount: number | null,
  minRatio: number = MIN_CATALOG_RATIO,
): CatalogVerdict {
  if (!Number.isFinite(newCount) || newCount <= 0) {
    return { ok: false, reason: 'the new catalog has 0 objects' };
  }
  if (cachedCount === null || !(cachedCount > 0)) {
    return { ok: true, reason: 'no cached catalog to compare with' };
  }
  if (newCount < cachedCount * minRatio) {
    const pct = ((newCount / cachedCount) * 100).toFixed(1);
    return {
      ok: false,
      reason:
        `the new catalog has ${newCount} objects, ${pct}% of the ${cachedCount} cached ` +
        `(minimum ${(minRatio * 100).toFixed(0)}%)`,
    };
  }
  return { ok: true, reason: `the new catalog has ${newCount} objects, the cache has ${cachedCount}` };
}

/** Returns true if the cache file exists AND its mtime is within the TTL. */
export function isCacheFresh(): boolean {
  const age = cacheAgeMs();
  return age !== null && age < CACHE_TTL_MS;
}

/**
 * Read the cached TLE array from disk.
 * Returns null if the file doesn't exist or is unreadable.
 */
export function readCache(): EnrichedTLEObject[] | null {
  const p = tleCachePath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as EnrichedTLEObject[];
  } catch (err) {
    logger.error('Failed to read TLE cache:', err);
    return null;
  }
}

/**
 * Read the raw TLE cache file as a UTF-8 string WITHOUT parsing it.
 *
 * The file on disk is already a JSON array, so the in-memory payload cache can
 * splice it into the response envelope by string concat — avoiding the 13.8 MB
 * JSON.parse → JSON.stringify roundtrip the per-request handler used to pay.
 * Returns null if the file doesn't exist or is unreadable.
 */
export function readRawTleCache(): string | null {
  const p = tleCachePath();
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    logger.error('Failed to read raw TLE cache:', err);
    return null;
  }
}

/**
 * Read the version metadata from disk.
 * Returns null if the file doesn't exist.
 */
export function readVersion(): VersionInfo | null {
  const p = versionPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as VersionInfo;
  } catch {
    return null;
  }
}

/** Returns true if visual-cache.json exists and was written within VISUAL_CACHE_TTL_MS. */
export function isVisualCacheFresh(): boolean {
  const p = visualCachePath();
  if (!fs.existsSync(p)) return false;
  const mtime = fs.statSync(p).mtimeMs;
  return Date.now() - mtime < VISUAL_CACHE_TTL_MS;
}

/**
 * Read the cached visual NORAD list from disk.
 * Returns null if missing, unreadable, or structurally invalid.
 */
export function readVisualCache(): VisualNoradCache | null {
  const p = visualCachePath();
  if (!fs.existsSync(p)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<VisualNoradCache>;
    if (typeof parsed.version !== 'string' || !Array.isArray(parsed.ids)) {
      logger.warn('Visual cache has invalid shape; ignoring it');
      return null;
    }

    const ids = normalizeNoradIds(parsed.ids);
    if (ids.length === 0) {
      logger.warn('Visual cache is empty or invalid; ignoring it');
      return null;
    }

    return {
      version: parsed.version,
      ids,
    };
  } catch (err) {
    logger.error('Failed to read visual cache:', err);
    return null;
  }
}

// ============================================================
// Write helpers
// ============================================================

/**
 * Atomically write the enriched TLE array and version metadata to disk.
 *
 * Atomic strategy: write to a .tmp file first, then rename.  This prevents
 * the server from ever reading a half-written cache.
 */
export function writeCache(data: EnrichedTLEObject[]): void {
  ensureCacheDir();

  const json = JSON.stringify(data);
  const byteSize = Buffer.byteLength(json, 'utf8');
  const version = new Date().toISOString();

  // Write the main cache atomically
  const tleP = tleCachePath();
  const tleTmp = tleP + '.tmp';
  fs.writeFileSync(tleTmp, json, 'utf8');
  fs.renameSync(tleTmp, tleP);

  // Write version metadata (small, non-critical — no need for atomic write)
  const versionInfo: VersionInfo = { version, count: data.length, byteSize };
  fs.writeFileSync(versionPath(), JSON.stringify(versionInfo, null, 2), 'utf8');

  logger.info(
    `Cache written: ${data.length} objects, ${(byteSize / 1_048_576).toFixed(1)} MB, version=${version}`,
  );
}

/** Atomically write the visual NORAD list cache to disk. */
export function writeVisualCache(ids: number[]): VisualNoradCache {
  ensureCacheDir();

  const payload: VisualNoradCache = {
    version: new Date().toISOString(),
    ids: normalizeNoradIds(ids),
  };

  const p = visualCachePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, p);

  logger.info(`Visual cache written: ${payload.ids.length} NORAD IDs, version=${payload.version}`);
  return payload;
}
