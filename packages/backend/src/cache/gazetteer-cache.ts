import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import type { GazetteerSourceRecord } from '../types/index.js';

// ============================================================
// File-based cache for the Natural Earth populated-places gazetteer.
// Mirrors cache/swpc-cache.ts's atomic-write + mtime-TTL pattern (separate
// file: this payload is ~7.3k place records, not the TLE catalog or the
// SWPC daily indices, so it doesn't belong wedged into either).
//
// data/gazetteer-cache.json — { version: ISO fetch timestamp, records: [...] }
//
// TTL: 30 days. Cities do not move — there is no freshness pressure like TLE
// orbital elements or daily space-weather indices; a long TTL just avoids
// re-paying the ~90s source fetch (see services/gazetteer.ts) on every server
// restart within that window.
// ============================================================

export const GAZETTEER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface GazetteerCache {
  version: string;
  records: GazetteerSourceRecord[];
}

function getCacheDir(): string {
  if (process.env.CACHE_DIR) return path.resolve(process.env.CACHE_DIR);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
}

function gazetteerCachePath(): string {
  return path.join(getCacheDir(), 'gazetteer-cache.json');
}

function ensureCacheDir(): void {
  fs.mkdirSync(getCacheDir(), { recursive: true });
}

/** Returns true if gazetteer-cache.json exists and was written within GAZETTEER_CACHE_TTL_MS. */
export function isGazetteerCacheFresh(): boolean {
  const p = gazetteerCachePath();
  if (!fs.existsSync(p)) return false;
  const mtime = fs.statSync(p).mtimeMs;
  return Date.now() - mtime < GAZETTEER_CACHE_TTL_MS;
}

/** Read the cached place records from disk. Null if missing/unreadable/invalid. */
export function readGazetteerCache(): GazetteerCache | null {
  const p = gazetteerCachePath();
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<GazetteerCache>;
    if (typeof parsed.version !== 'string' || !Array.isArray(parsed.records)) {
      logger.warn('Gazetteer cache has invalid shape; ignoring it');
      return null;
    }
    return { version: parsed.version, records: parsed.records };
  } catch (err) {
    logger.error('Failed to read gazetteer cache:', err);
    return null;
  }
}

/** Atomically write the place records to disk. */
export function writeGazetteerCache(records: GazetteerSourceRecord[]): GazetteerCache {
  ensureCacheDir();

  const payload: GazetteerCache = { version: new Date().toISOString(), records };
  const p = gazetteerCachePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, p);

  logger.info(`Gazetteer cache written: ${records.length} place records, version=${payload.version}`);
  return payload;
}
