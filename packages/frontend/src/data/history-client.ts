import type { EnrichedTLEObject } from './types';
import { buildCatalogResult, type TleCatalogResult } from './tle-client';
import { readHistoryDayCache, writeHistoryDayCache } from './history-cache';

// ============================================================
// Historical catalog client — the "review" data source.
//
// Pairs with the live-now source (tle-client.ts). Fetches the catalog as-of a UTC
// day from the backend history DB and shapes it into the SAME TleCatalogResult the
// live bootstrap produces, so the engine re-seed path is identical regardless of
// where the catalog came from. Past days are served from a per-day IndexedDB cache
// (history-cache.ts) so re-scrubbing is instant; "today" honors a short TTL.
//
// No store side effects (mirrors tle-client). Fully graceful: returns null when
// history is unavailable (backend 503 when DATABASE_URL is unset), the day is out
// of coverage, or the network fails with no cached copy.
// ============================================================

export interface HistoryCoverage {
  from: string | null;          // earliest UTC day 'YYYY-MM-DD'
  to: string | null;            // latest UTC day 'YYYY-MM-DD'
  objectCount: number;
  lastIngestAt: string | null;  // ISO of the most recent ingest
}

/** "Today" snapshots can still change as new elsets ingest → short refetch TTL. */
const TODAY_TTL_MS = 5 * 60 * 1000;

/** UTC day 'YYYY-MM-DD' for a Date / epoch-ms / ISO string. */
export function utcDay(when: Date | number | string): string {
  return new Date(when).toISOString().slice(0, 10);
}

/**
 * Coverage span the backend can serve (drives the scrubber bounds). Returns null
 * when history is disabled/unavailable (backend 503) or on any error.
 */
export async function fetchHistoryCoverage(apiUrl: string): Promise<HistoryCoverage | null> {
  try {
    const res = await fetch(`${apiUrl}/api/history/coverage`);
    if (!res.ok) return null; // 503 when DATABASE_URL unset → history off
    const cov = (await res.json()) as HistoryCoverage;
    if (!cov || typeof cov !== 'object') return null;
    return cov;
  } catch {
    return null;
  }
}

interface HistoryAtResponse {
  version: string;
  count: number;
  data: EnrichedTLEObject[];
}

async function fetchHistoryDayFromNetwork(
  apiUrl: string,
  day: string,
): Promise<HistoryAtResponse | null> {
  const res = await fetch(`${apiUrl}/api/history/at?t=${encodeURIComponent(day)}`);
  if (!res.ok) return null; // 422 out-of-coverage / 503 disabled / etc.
  const body = (await res.json()) as HistoryAtResponse;
  if (!body || !Array.isArray(body.data)) return null;
  return body;
}

/**
 * Catalog as-of a UTC `day` ('YYYY-MM-DD'), shaped like the live bootstrap
 * (TleCatalogResult). Cache-first for past days (immutable); short TTL for today.
 * Returns null when the day can't be served and no cached copy exists.
 */
export async function fetchHistoryDay(apiUrl: string, day: string): Promise<TleCatalogResult | null> {
  const isToday = day === utcDay(Date.now());
  const cached = await readHistoryDayCache(day);

  // Past days never change → serve cache outright. Today → honor a short TTL.
  if (cached && (!isToday || Date.now() - cached.fetchedAt < TODAY_TTL_MS)) {
    return buildCatalogResult(cached.catalogData);
  }

  const fresh = await fetchHistoryDayFromNetwork(apiUrl, day);
  if (!fresh) {
    // Network/coverage failure → fall back to any cached copy (even if stale).
    return cached ? buildCatalogResult(cached.catalogData) : null;
  }

  void writeHistoryDayCache({
    day,
    version: fresh.version,
    fetchedAt: Date.now(),
    catalogData: fresh.data,
  });
  return buildCatalogResult(fresh.data);
}
