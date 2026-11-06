import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import {
  SSA_PASS_CIRCLE_MAX_KM, SSA_PASS_CIRCLE_MIN_KM, SSA_PASS_MAX_WINDOW_DAYS,
  type SsaPassesResponse, type SsaRegionInfo, type SsaRegionsResponse,
} from '@orbitwatch/contracts';
import { getPool, isHistoryReady } from '../history/db/pool.js';
import {
  GUARANTEE, PassesError, REGIONS, circleRegion, loadNames, namedRegion, passesOver,
  type PassesOpts, type PassesResultWithIds, type Region,
} from '../ssa/passes/index.js';
import { historyPaths } from '../ssa/config.js';
import { getHistoryStore } from '../ssa/history/store.js';
import { logger } from '../utils/logger.js';

// ============================================================
// Ground passes over time, mounted at /api/ssa/passes (and the region list at /api/ssa/regions).
//
//   GET /api/ssa/passes?region=india | lat=&lon=&radiusKm=  &from=&to=  [&norad=] [&limit=] [&fill=1]
//        → who passed over the region in the window (≤ 90 days), and when (1 s), from the nightly star-map coverage files.
//          `totalObjects` counts every object with a pass; `objects` lists the first `limit` of them (lowest NORAD id first) with
//          their pass intervals. `missingDays` lists days of the window without coverage files (never silently skipped).
//   GET /api/ssa/regions → the named regions (India careful, the rest approximate) and the circle limits.
//
// History: windows over days of SSA_HISTORY_DIR (1959 on) work like any other (coverage fallback, see ssa/passes/query.ts); names come from
// the database, else from the history root's objects file.
// Past windows are immutable: `public, max-age=3600` when `to` is before today (UTC), 60 s otherwise. 400 on bad input, 503 without
// history, 429 when too many pass queries are already running. The first query over a long window computes (tens of seconds for a
// whole-catalog region such as India); repeats are served from memory.
// ============================================================

const DAY_MS = 86_400_000;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_NORAD = 2_147_483_647;
const DEFINITION = 'An object passed over a region when its sub-satellite point (geodetic latitude and longitude) was inside the region, at any height within the star-map range. Times are the first and last 1-second sample inside.';

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const single = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === 'string' ? v : null);

function num(name: string, raw: unknown, min: number, max: number): Parsed<number | undefined> {
  const s = single(raw);
  if (s === undefined) return { ok: true, value: undefined };
  if (s === null || s.trim() === '' || !Number.isFinite(Number(s))) return bad(`Invalid \`${name}\` (expected a number).`);
  const n = Number(s);
  if (n < min || n > max) return bad(`Invalid \`${name}\` (expected ${min}..${max}).`);
  return { ok: true, value: n };
}
function int(name: string, raw: unknown, min: number, max: number): Parsed<number | undefined> {
  const s = single(raw);
  if (s === undefined) return { ok: true, value: undefined };
  if (s === null || !/^\d+$/.test(s)) return bad(`Invalid \`${name}\` (expected an integer).`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) return bad(`Invalid \`${name}\` (expected ${min}..${max}).`);
  return { ok: true, value: n };
}
function instant(name: string, raw: unknown): Parsed<number | undefined> {
  const s = single(raw);
  if (s === undefined) return { ok: true, value: undefined };
  if (s === null || !/^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(s)) return bad(`Invalid \`${name}\` (expected an ISO date/time).`);
  let str = s.replace(' ', 'T');
  if (str.length > 10 && !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str)) str += 'Z'; // no zone: UTC (a bare date parses as UTC already)
  const t = Date.parse(str);
  return Number.isNaN(t) ? bad(`Invalid \`${name}\` (expected an ISO date/time).`) : { ok: true, value: t };
}

export const regionInfo = (r: Region): SsaRegionInfo => ({
  id: r.id, name: r.name, kind: r.kind, approximate: r.approximate,
  ...(r.kind === 'circle' ? { latDeg: r.latDeg, lonDeg: r.lonDeg, radiusKm: r.radiusKm } : {}),
});

export interface PassesQuery { region: Region; fromMs: number; toMs: number; norad?: number; limit: number; fill: boolean }

export function parsePassesQuery(q: Request['query'], nowMs: number): Parsed<PassesQuery> {
  const name = single(q.region);
  if (name === null) return bad('Invalid `region`.');
  const lat = num('lat', q.lat, -90, 90); if (!lat.ok) return lat;
  const lon = num('lon', q.lon, -180, 180); if (!lon.ok) return lon;
  const rad = num('radiusKm', q.radiusKm, SSA_PASS_CIRCLE_MIN_KM, SSA_PASS_CIRCLE_MAX_KM); if (!rad.ok) return rad;
  const anyCircle = lat.value !== undefined || lon.value !== undefined || rad.value !== undefined;
  let region: Region;
  if (name !== undefined) {
    if (anyCircle) return bad('Give either `region` or `lat`, `lon` and `radiusKm`, not both.');
    const r = namedRegion(name);
    if (!r) return bad(`Unknown region '${name.slice(0, 40)}' (known: ${REGIONS.map((x) => x.id).join(', ')}).`);
    region = r;
  } else {
    if (lat.value === undefined || lon.value === undefined || rad.value === undefined) return bad('Give `region`, or all of `lat`, `lon` and `radiusKm`.');
    try { region = circleRegion(lat.value, lon.value, rad.value); } catch (e) { return bad(`Invalid circle: ${(e as Error).message}.`); }
  }
  const to = instant('to', q.to); if (!to.ok) return to;
  const from = instant('from', q.from); if (!from.ok) return from;
  if (from.value === undefined) return bad('`from` is required.');
  const toMs = to.value ?? nowMs;
  if (from.value >= toMs) return bad('`from` must be before `to`.');
  if (toMs - from.value > SSA_PASS_MAX_WINDOW_DAYS * DAY_MS) return bad(`The window may be at most ${SSA_PASS_MAX_WINDOW_DAYS} days.`);
  const norad = int('norad', q.norad, 1, MAX_NORAD); if (!norad.ok) return norad;
  const limit = int('limit', q.limit, 0, MAX_LIMIT); if (!limit.ok) return limit;
  const fillRaw = single(q.fill);
  if (fillRaw === null || (fillRaw !== undefined && !['0', '1', 'true', 'false'].includes(fillRaw))) return bad('Invalid `fill` (expected 0 or 1).');
  return { ok: true, value: { region, fromMs: from.value, toMs, ...(norad.value !== undefined ? { norad: norad.value } : {}), limit: limit.value ?? DEFAULT_LIMIT, fill: fillRaw === '1' || fillRaw === 'true' } };
}

export interface SsaPassesRouterDeps {
  /** the pool, or null when history is unavailable */
  getDb: () => Pool | null;
  /** the query (injectable for tests) */
  passes?: (pool: Pool, region: Region, fromMs: number, toMs: number, opts: PassesOpts) => Promise<PassesResultWithIds>;
  names?: (pool: Pool, ids: number[]) => Promise<Map<number, string>>;
  coverageDir?: string;
  now?: () => number;
}

export function createSsaPassesRouter(deps: SsaPassesRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const run = deps.passes ?? passesOver;
  const names = deps.names ?? loadNames;

  router.get('/', async (req: Request, res: Response) => {
    const nowMs = now();
    const parsed = parsePassesQuery(req.query, nowMs);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const q = parsed.value;
    const db = deps.getDb();
    if (!db) { res.status(503).json({ error: 'Pass data is not available.' }); return; }
    try {
      const r = await run(db, q.region, q.fromMs, q.toMs, { limit: q.limit, fill: q.fill, nowMs, ...(q.norad !== undefined ? { norad: q.norad } : {}), ...(deps.coverageDir ? { dir: deps.coverageDir } : {}) });
      const nm = await names(db, r.objects.map((o) => o.noradId)).catch(() => new Map<number, string>());
      // history days: objects the live database does not know (decayed long ago) are named by the history root's objects file
      const root = historyPaths();
      if (root && r.objects.some((o) => !nm.get(o.noradId))) {
        try {
          const hist = getHistoryStore(root).objects();
          for (const o of r.objects) if (!nm.get(o.noradId)) { const n = hist.get(o.noradId)?.name; if (n) nm.set(o.noradId, n); }
        } catch (err) { logger.warn('passes: history object names unavailable:', (err as Error).message); }
      }
      const iso = (t: number) => new Date(t).toISOString();
      const body: SsaPassesResponse = {
        region: regionInfo(q.region),
        from: iso(r.fromMs), to: iso(r.toMs), clippedToNow: r.clippedToNow,
        totalObjects: r.totalObjects,
        objects: r.objects.map((o) => ({ noradId: o.noradId, name: nm.get(o.noradId) ?? null, passes: o.passes.map(([a, b]) => ({ start: iso(a), end: iso(b) })), count: o.passes.length })),
        missingDays: r.missingDays, filledDays: r.filledDays,
        guarantee: GUARANTEE, definition: DEFINITION,
        timing: { wallS: r.stats.wallS, days: r.stats.days, candidateObjectDays: r.stats.candidateObjectDays, refinedObjectDays: r.stats.refinedObjectDays },
      };
      const json = JSON.stringify(body);
      const etag = `"pass-${createHash('sha1').update(json).digest('hex').slice(0, 20)}"`;
      // a window that ended before today (UTC) and has no gap cannot change: cache it for an hour
      const settled = r.toMs <= Math.floor(nowMs / DAY_MS) * DAY_MS && r.missingDays.length === 0;
      res.setHeader('Cache-Control', `public, max-age=${settled ? 3600 : 60}`);
      res.setHeader('ETag', etag);
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string' && inm.split(',').some((t) => t.trim() === etag)) { res.status(304).end(); return; }
      res.type('application/json').send(json);
    } catch (err) {
      if (err instanceof PassesError) {
        const status = err.code === 'busy' ? 429 : 400;
        if (err.code === 'busy') res.setHeader('Retry-After', '30');
        res.status(status).json({ error: err.message });
        return;
      }
      logger.error('GET /api/ssa/passes failed:', (err as Error).message);
      if (!res.headersSent) res.status(503).json({ error: 'Pass data is not available.' });
    }
  });
  return router;
}

export function createSsaRegionsRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    const body: SsaRegionsResponse = {
      regions: REGIONS.map(regionInfo),
      circle: { minRadiusKm: SSA_PASS_CIRCLE_MIN_KM, maxRadiusKm: SSA_PASS_CIRCLE_MAX_KM },
      maxWindowDays: SSA_PASS_MAX_WINDOW_DAYS,
    };
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(body);
  });
  return router;
}

/** Production routers: the shared history pool, available only once history is ready. */
export const ssaPassesRouter = createSsaPassesRouter({ getDb: () => (isHistoryReady() ? getPool() : null) });
export const ssaRegionsRouter = createSsaRegionsRouter();
