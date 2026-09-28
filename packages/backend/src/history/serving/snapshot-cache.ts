import zlib from 'node:zlib';
import type { CatalogResponse } from '@orbitwatch/contracts';
import { getPool } from '../db/pool.js';
import { getAsOfCatalog } from '../db/queries.js';
import { logger } from '../../utils/logger.js';

// ============================================================
// Day-snapshot cache — the history analogue of tle-payload-cache.ts.
//
// Builds the pre-gzipped /api/history/at response body ONCE per UTC day and
// holds it in a small LRU. Response shape is identical to /api/tle/all
// ({version,count,data}) so the client re-seeds with zero special-casing.
//
// Freshness: a PAST day is immutable (forward-only never rewrites old days), so
// its cached entry is served indefinitely. TODAY's entry can change as new
// elsets ingest, so it carries a short TTL and an ETag derived from the data's
// max ingested_at, giving correct 304s.
// ============================================================

const MAX_DAYS = 32;        // ~a month of distinct day snapshots in memory
const TODAY_TTL_MS = 60_000; // re-build today's snapshot at most once a minute

export interface DaySnapshot {
  day: string;   // 'YYYY-MM-DD' (also the response `version`)
  etag: string;  // `"<day>:<maxIngestedAt>"`
  count: number;
  gzip: Buffer;
  builtAt: number;
}

const cache = new Map<string, DaySnapshot>();

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function buildDaySnapshot(day: string): Promise<DaySnapshot | null> {
  const pool = getPool();
  if (!pool) return null;

  const { objects, maxIngestedAt } = await getAsOfCatalog(pool, day);

  // Same envelope as /api/tle/all (@orbitwatch/contracts CatalogResponse). Built
  // per-day and cached, so the JSON.stringify here (unlike the live hot path)
  // is paid at most once per day.
  const envelope = JSON.stringify(
    { version: day, count: objects.length, data: objects } satisfies CatalogResponse,
  );
  const gzip = zlib.gzipSync(Buffer.from(envelope, 'utf8'), { level: 9 });

  return {
    day,
    etag: `"${day}:${maxIngestedAt ?? '0'}"`,
    count: objects.length,
    gzip,
    builtAt: Date.now(),
  };
}

/**
 * Return the pre-gzipped snapshot for a UTC day, building + caching on miss.
 * Returns null when history is unavailable or the build fails.
 */
export async function getDaySnapshot(day: string): Promise<DaySnapshot | null> {
  const isToday = day === todayUtc();
  const hit = cache.get(day);
  if (hit && (!isToday || Date.now() - hit.builtAt < TODAY_TTL_MS)) {
    // Refresh LRU recency.
    cache.delete(day);
    cache.set(day, hit);
    return hit;
  }

  let built: DaySnapshot | null;
  try {
    built = await buildDaySnapshot(day);
  } catch (err) {
    logger.error(`History snapshot build failed for ${day}:`, (err as Error).message);
    return null;
  }
  if (!built) return null;

  cache.set(day, built);
  while (cache.size > MAX_DAYS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return built;
}
