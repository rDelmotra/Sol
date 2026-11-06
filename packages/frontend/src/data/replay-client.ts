// ============================================================
// replay-client.ts — read-only client for the history REPLAY API.
//
//   range()            GET /api/history/range       (once per session)
//   catalog(day)       GET /api/history/catalog?day (memory LRU → IndexedDB → network,
//                      concurrent calls for one day share the request in flight)
//   prefetch(day)      warm a day (the day-boundary swap reads it from memory)
//   timeline(...)      GET /api/history/timeline    (memory cache per query)
//   events(...)        GET /api/ssa/events          (memory cache per query)
//
// No store side effects. 503 (history data not configured), any other non-OK
// status, a malformed body or a network failure all mean "no data": null, never a
// throw — so live mode is untouched when the archive is absent.
// ============================================================

import type { SsaEvent, SsaEventsResponse } from '@orbitwatch/contracts';
import { idbReplayCache, type ReplayDiskCache } from './replay-cache';
import type { HistoryCatalogResponse, HistoryRange, TimelineGranularity, HistoryTimelinePoint } from './replay-types';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReplayClientOptions {
  apiUrl: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: (url: string) => Promise<Response>;
  /** Disk cache; defaults to IndexedDB (a no-op where unavailable). */
  disk?: ReplayDiskCache;
  /** Days of parsed catalogs kept in memory (current + neighbours). */
  memoryDays?: number;
  /** Clock for the negative cache (tests). */
  now?: () => number;
}

/** A day that could not be served (gap in the archive, 404, 503, network) is not asked for again for this long. */
export const MISSING_DAY_TTL_MS = 5 * 60 * 1000;

export interface ReplayEventQuery {
  from: string;
  to: string;
  kind?: string;
  norad?: number;
  limit?: number;
}

export interface ReplayClient {
  range(): Promise<HistoryRange | null>;
  catalog(day: string): Promise<HistoryCatalogResponse | null>;
  prefetch(day: string): void;
  /** True when `day` is parsed in memory (an instant swap). */
  hasInMemory(day: string): boolean;
  timeline(from: string, to: string, bucket: TimelineGranularity, kinds?: readonly string[]): Promise<HistoryTimelinePoint[] | null>;
  events(q: ReplayEventQuery): Promise<SsaEvent[] | null>;
  /** Forget memory caches (tests / manual refresh). */
  clear(): void;
}

function isRange(x: unknown): x is HistoryRange {
  const r = x as HistoryRange | null;
  return !!r && typeof r === 'object' && DAY_RE.test(String(r.firstDay)) && DAY_RE.test(String(r.lastDay)) && r.firstDay <= r.lastDay;
}

function isCatalog(x: unknown): x is HistoryCatalogResponse {
  const c = x as HistoryCatalogResponse | null;
  return !!c && typeof c === 'object' && Array.isArray(c.objects);
}

export function createReplayClient(opts: ReplayClientOptions): ReplayClient {
  const base = opts.apiUrl;
  const doFetch = opts.fetchImpl ?? ((url: string) => fetch(url));
  const disk = opts.disk ?? idbReplayCache;
  const memoryDays = Math.max(1, opts.memoryDays ?? 3);
  const now = opts.now ?? (() => Date.now());
  /** day → when it failed (negative cache, so a gap day is not re-requested every tick). */
  const missing = new Map<string, number>();

  let rangePromise: Promise<HistoryRange | null> | null = null;
  /** Insertion order = recency (re-inserted on hit). */
  const memory = new Map<string, HistoryCatalogResponse>();
  const inFlight = new Map<string, Promise<HistoryCatalogResponse | null>>();
  const timelineCache = new Map<string, HistoryTimelinePoint[]>();
  const eventsCache = new Map<string, SsaEvent[]>();

  async function getJson(url: string): Promise<unknown | null> {
    try {
      const res = await doFetch(url);
      if (!res.ok) return null; // 503 = archive not configured; 4xx = out of range
      return await res.json();
    } catch {
      return null;
    }
  }

  function remember(day: string, body: HistoryCatalogResponse): void {
    memory.delete(day);
    memory.set(day, body);
    while (memory.size > memoryDays) {
      const oldest = memory.keys().next().value as string;
      memory.delete(oldest);
    }
  }

  const client: ReplayClient = {
    range() {
      rangePromise ??= getJson(`${base}/api/history/range`).then((r) => (isRange(r) ? r : null));
      return rangePromise;
    },

    catalog(day) {
      if (!DAY_RE.test(day)) return Promise.resolve(null);
      const hit = memory.get(day);
      if (hit) {
        remember(day, hit);
        return Promise.resolve(hit);
      }
      const pending = inFlight.get(day);
      if (pending) return pending;
      const failedAt = missing.get(day);
      if (failedAt !== undefined && now() - failedAt < MISSING_DAY_TTL_MS) return Promise.resolve(null);
      const p = (async () => {
        try {
          const cached = await disk.read(day);
          if (cached) {
            remember(day, cached);
            return cached;
          }
          const body = await getJson(`${base}/api/history/catalog?day=${encodeURIComponent(day)}`);
          if (!isCatalog(body)) {
            missing.set(day, now());
            return null;
          }
          missing.delete(day);
          remember(day, body);
          void disk.write(day, body);
          return body;
        } finally {
          inFlight.delete(day);
        }
      })();
      inFlight.set(day, p);
      return p;
    },

    prefetch(day) {
      if (memory.has(day) || inFlight.has(day)) return;
      void client.catalog(day);
    },

    hasInMemory(day) {
      return memory.has(day);
    },

    async timeline(from, to, bucket, kinds) {
      const params = new URLSearchParams({ from, to, bucket });
      if (kinds && kinds.length > 0) params.set('kinds', kinds.join(','));
      const key = params.toString();
      const hit = timelineCache.get(key);
      if (hit) return hit;
      const body = await getJson(`${base}/api/history/timeline?${key}`);
      // Accept a bare array (the contract) or a { buckets } envelope.
      const arr = Array.isArray(body) ? body : Array.isArray((body as { buckets?: unknown })?.buckets) ? (body as { buckets: unknown[] }).buckets : null;
      if (!arr) return null;
      const points = arr.filter(
        (p): p is HistoryTimelinePoint => !!p && typeof (p as HistoryTimelinePoint).t === 'string' && typeof (p as HistoryTimelinePoint).counts === 'object',
      );
      timelineCache.set(key, points);
      return points;
    },

    async events(q) {
      const params = new URLSearchParams({ from: q.from, to: q.to });
      if (q.kind) params.set('kind', q.kind);
      if (q.norad !== undefined) params.set('norad', String(q.norad));
      if (q.limit !== undefined) params.set('limit', String(q.limit));
      const key = params.toString();
      const hit = eventsCache.get(key);
      if (hit) return hit;
      const body = (await getJson(`${base}/api/ssa/events?${key}`)) as SsaEventsResponse | SsaEvent[] | null;
      const events = Array.isArray(body) ? body : body && Array.isArray(body.events) ? body.events : null;
      if (!events) return null;
      eventsCache.set(key, events);
      return events;
    },

    clear() {
      rangePromise = null;
      memory.clear();
      missing.clear();
      inFlight.clear();
      timelineCache.clear();
      eventsCache.clear();
    },
  };
  return client;
}

const clients = new Map<string, ReplayClient>();

/** One shared client per API base (the engine and the UI share its caches). */
export function getReplayClient(apiUrl: string = import.meta.env?.VITE_API_URL ?? ''): ReplayClient {
  let c = clients.get(apiUrl);
  if (!c) {
    c = createReplayClient({ apiUrl });
    clients.set(apiUrl, c);
  }
  return c;
}
