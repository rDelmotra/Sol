import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { HistoryRange, HistoryTimelineBucket } from '@orbitwatch/contracts';
import { getPool, isHistoryReady } from '../history/db/pool.js';
import { historyPaths, historyPathsFrom, type HistoryPaths } from '../ssa/config.js';
import { DAY_RE, getHistoryStore, isRealDay, type HistoryStore } from '../ssa/history/store.js';
import { logger } from '../utils/logger.js';

// ============================================================
// History API, mounted at /api/history BEFORE the older routes of src/history (which keep /coverage and /at):
//
//   GET /range                         → HistoryRange: first / last built day, count, events extent, hasCoverage
//   GET /catalog?day=YYYY-MM-DD        → HistoryCatalog: the catalog as of the END of that day (every object with its latest element set
//                                        before then, the era's staleness window, the era's propagator), gzip-friendly
//   GET /timeline?from=&to=&bucket=day|month|year&kinds=a,b   → HistoryTimelineBucket[] from ssa_event (SQL group by)
//
// Event lists are /api/ssa/events (with from, to and a kind list). 400 {error} on bad input (before anything else is looked at); 503
// when SSA_HISTORY_DIR is unset or missing (and, for the timeline, when the database is unavailable). History does not change:
// answers carry `public, max-age=604800` and an ETag (the range: five minutes).
// ============================================================

const WEEK = 604_800;
const MAX_BUCKETS = 60_000;
const KIND_RE = /^[a-z][a-z0-9_.]{0,39}$/i;
const MAX_KINDS = 16;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const single = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === 'string' ? v : null);

function day(name: string, raw: unknown): Parsed<string | undefined> {
  const s = single(raw);
  if (s === undefined) return { ok: true, value: undefined };
  if (s === null || !isRealDay(s)) return bad(`Invalid \`${name}\` (expected a day, YYYY-MM-DD).`);
  return { ok: true, value: s };
}

export interface TimelineQuery { from?: string; to?: string; bucket: 'day' | 'month' | 'year'; kinds?: string[] }

export function parseTimelineQuery(q: Request['query']): Parsed<TimelineQuery> {
  const from = day('from', q.from); if (!from.ok) return from;
  const to = day('to', q.to); if (!to.ok) return to;
  if (from.value && to.value && from.value > to.value) return bad('`from` must not be after `to`.');
  const b = single(q.bucket);
  if (b === null || (b !== undefined && !['day', 'month', 'year'].includes(b))) return bad('Invalid `bucket` (expected day, month or year).');
  const k = single(q.kinds);
  let kinds: string[] | undefined;
  if (k === null) return bad('Invalid `kinds`.');
  if (k !== undefined) {
    kinds = k.split(',').map((x) => x.trim()).filter(Boolean);
    if (!kinds.length || kinds.length > MAX_KINDS || kinds.some((x) => !KIND_RE.test(x))) return bad('Invalid `kinds` (comma separated event kinds).');
  }
  return { ok: true, value: { bucket: (b ?? 'month') as TimelineQuery['bucket'], ...(from.value ? { from: from.value } : {}), ...(to.value ? { to: to.value } : {}), ...(kinds ? { kinds } : {}) } };
}

/** Number of buckets a query would return at most (so a day histogram of 70 years is refused, not computed). */
export function bucketCount(from: string, to: string, bucket: TimelineQuery['bucket']): number {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
  const days = Math.floor((b - a) / 86_400_000) + 1;
  return bucket === 'day' ? days : bucket === 'month' ? Math.ceil(days / 28) + 1 : Math.ceil(days / 365) + 1;
}

const TIMELINE_SQL = `
  SELECT to_char(date_trunc($1, day::timestamp), 'YYYY-MM-DD') AS t, kind, count(*)::int AS n
    FROM ssa_event
   WHERE day >= $2::date AND day <= $3::date AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
   GROUP BY 1, 2
   ORDER BY 1, 2`;

export interface HistoryRouterDeps {
  /** the history root (string) or explicit paths, or null (default: SSA_HISTORY_DIR and the SSA_HISTORY_* overrides, read per request) */
  root?: () => string | HistoryPaths | null;
  /** the pool, or null when the database is unavailable */
  getDb?: () => Pick<Pool, 'query'> | null;
  now?: () => number;
}

export function createHistoryApiRouter(deps: HistoryRouterDeps = {}): Router {
  const router = Router();
  const rootOf = deps.root ?? historyPaths;
  const dbOf = deps.getDb ?? (() => (isHistoryReady() ? getPool() : null));
  const now = deps.now ?? Date.now;
  const timelineCache = new Map<string, { at: number; json: string }>();

  /** the store, or a 503 */
  const store = (res: Response): HistoryStore | null => {
    const root = rootOf();
    const paths = typeof root === 'string' ? historyPathsFrom(root) : root;
    const s = paths ? getHistoryStore(paths) : null;
    if (!s || !s.available()) { res.status(503).json({ error: 'History data is not available.' }); return null; }
    return s;
  };
  const etagged = (req: Request, res: Response, tag: string, cache: string): boolean => {
    const etag = `"hist-${tag}"`;
    res.setHeader('Cache-Control', cache);
    res.setHeader('ETag', etag);
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) { res.status(304).end(); return true; }
    return false;
  };

  router.get('/range', (req, res) => {
    const s = store(res); if (!s) return;
    try {
      const body: HistoryRange = s.range(now());
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(body);
    } catch (err) {
      logger.error('GET /api/history/range failed:', (err as Error).message);
      if (!res.headersSent) res.status(503).json({ error: 'History data is not available.' });
    }
  });

  router.get('/catalog', (req, res) => {
    const d = day('day', req.query.day);
    if (!d.ok) { res.status(400).json({ error: d.error }); return; }
    if (!d.value) { res.status(400).json({ error: '`day` is required.' }); return; }
    const s = store(res); if (!s) return;
    try {
      const ext = s.catalogExtent();
      if (!ext.first || d.value < ext.first || d.value > ext.last!) {
        res.status(404).json({ error: `No history for ${d.value} (available ${ext.first ?? '-'} .. ${ext.last ?? '-'}).` });
        return;
      }
      const b = s.catalogGz(d.value);
      res.setHeader('X-Catalog-Source', b.source);
      if (etagged(req, res, `cat-${d.value}-${createHash('sha1').update(b.gz).digest('hex').slice(0, 12)}`, `public, max-age=${WEEK}`)) return;
      res.type('application/json');
      res.setHeader('Vary', 'Accept-Encoding');
      if (String(req.headers['accept-encoding'] ?? '').includes('gzip')) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(b.gz.length));
        res.end(b.gz);
      } else {
        res.end(gunzipSync(b.gz));
      }
    } catch (err) {
      logger.error('GET /api/history/catalog failed:', (err as Error).message);
      if (!res.headersSent) res.status(503).json({ error: 'History data is not available.' });
    }
  });

  router.get('/timeline', async (req, res) => {
    const p = parseTimelineQuery(req.query);
    if (!p.ok) { res.status(400).json({ error: p.error }); return; }
    const s = store(res); if (!s) return;
    const db = dbOf();
    if (!db) { res.status(503).json({ error: 'Event data is not available.' }); return; }
    try {
      const r = s.range(now());
      const from = p.value.from ?? r.eventsFirstDay ?? r.firstDay ?? '1957-10-04';
      const to = p.value.to ?? r.eventsLastDay ?? r.lastDay ?? new Date(now()).toISOString().slice(0, 10);
      if (from > to) { res.status(400).json({ error: '`from` must not be after `to`.' }); return; }
      if (bucketCount(from, to, p.value.bucket) > MAX_BUCKETS) { res.status(400).json({ error: `Too many buckets (more than ${MAX_BUCKETS}); use a coarser \`bucket\` or a shorter window.` }); return; }
      const key = `${from}|${to}|${p.value.bucket}|${(p.value.kinds ?? []).join(',')}`;
      const hit = timelineCache.get(key);
      let json = hit && now() - hit.at < 300_000 ? hit.json : null;
      if (json === null) {
        const { rows } = await db.query(TIMELINE_SQL, [p.value.bucket, from, to, p.value.kinds ?? null]) as { rows: Array<{ t: string; kind: string; n: number }> };
        const out: HistoryTimelineBucket[] = [];
        for (const row of rows) {
          const t = `${row.t}T00:00:00.000Z`;
          let last = out[out.length - 1];
          if (!last || last.t !== t) { last = { t, counts: {} }; out.push(last); }
          last.counts[row.kind] = row.n;
        }
        json = JSON.stringify(out);
        timelineCache.set(key, { at: now(), json });
        while (timelineCache.size > 64) timelineCache.delete(timelineCache.keys().next().value as string);
      }
      const past = to < new Date(now()).toISOString().slice(0, 10);
      if (etagged(req, res, `tl-${createHash('sha1').update(key + json).digest('hex').slice(0, 16)}`, `public, max-age=${past ? WEEK : 300}`)) return;
      res.type('application/json').send(json);
    } catch (err) {
      logger.error('GET /api/history/timeline failed:', (err as Error).message);
      if (!res.headersSent) res.status(503).json({ error: 'Event data is not available.' });
    }
  });

  return router;
}

export { DAY_RE };
const historyApiRouter = createHistoryApiRouter();
export default historyApiRouter;
