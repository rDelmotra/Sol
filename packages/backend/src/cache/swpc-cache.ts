import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import type { SwpcDailyIndex } from '../types/index.js';

// ============================================================
// File-based cache for NOAA SWPC daily space-weather indices.
// Mirrors file-cache.ts's atomic-write + mtime-TTL pattern (separate file:
// the payload is a handful of daily records, not the TLE catalog, so it
// doesn't belong wedged into file-cache.ts's TLE-specific helpers).
//
// data/swpc-cache.json — { version: ISO fetch timestamp, records: [...] }
//
// TTL: NOAA republishes both source text products roughly once/day (plus
// occasional intraday revisions to the current day's row); a 12h TTL keeps
// the provider re-fetching at most twice a day without hammering the
// endpoint — same spirit as file-cache.ts's 8h/24h TTLs.
// ============================================================

export const SWPC_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface SwpcCache {
  version: string;
  records: SwpcDailyIndex[];
}

function getCacheDir(): string {
  if (process.env.CACHE_DIR) return path.resolve(process.env.CACHE_DIR);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
}

function swpcCachePath(): string {
  return path.join(getCacheDir(), 'swpc-cache.json');
}

function ensureCacheDir(): void {
  fs.mkdirSync(getCacheDir(), { recursive: true });
}

/** Returns true if swpc-cache.json exists and was written within SWPC_CACHE_TTL_MS. */
export function isSwpcCacheFresh(): boolean {
  const p = swpcCachePath();
  if (!fs.existsSync(p)) return false;
  const mtime = fs.statSync(p).mtimeMs;
  return Date.now() - mtime < SWPC_CACHE_TTL_MS;
}

/** Read the cached daily index records from disk. Null if missing/unreadable/invalid. */
export function readSwpcCache(): SwpcCache | null {
  const p = swpcCachePath();
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<SwpcCache>;
    if (typeof parsed.version !== 'string' || !Array.isArray(parsed.records)) {
      logger.warn('SWPC cache has invalid shape; ignoring it');
      return null;
    }
    return { version: parsed.version, records: parsed.records };
  } catch (err) {
    logger.error('Failed to read SWPC cache:', err);
    return null;
  }
}

/** Atomically write the daily index records to disk. */
export function writeSwpcCache(records: SwpcDailyIndex[]): SwpcCache {
  ensureCacheDir();

  const payload: SwpcCache = { version: new Date().toISOString(), records };
  const p = swpcCachePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, p);

  logger.info(`SWPC cache written: ${records.length} daily records, version=${payload.version}`);
  return payload;
}
