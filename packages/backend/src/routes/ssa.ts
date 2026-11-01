import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type {
  ObjectEncounters,
  SsaConjunctionsResponse,
  SsaEventsResponse,
} from '@orbitwatch/contracts';
import { getPool, isHistoryReady } from '../history/db/pool.js';
import {
  getEncounterDetail,
  getLatestRun,
  listCurrentEncounters,
  listEvents,
  type ConjunctionFilter,
  type ConjunctionSort,
  type EventFilter,
  type Queryable,
} from '../ssa/queries/index.js';
import { logger } from '../utils/logger.js';

// ============================================================
// Encounter (close-approach) read API, mounted at /api/ssa.
//
//   GET /run                → latest screening run
//   GET /conjunctions       → current run's encounters (filters + sort + limit)
//   GET /conjunctions/:id   → one encounter with its per-run update history
//   GET /objects/:norad     → one object's current encounters + recent events
//   GET /events             → derived event feed
//
// Data changes once per run, so responses carry `public, max-age=300` and an
// ETag keyed by the latest run id + the request's canonical query. Parameters
// are validated before the database is touched (400 {error}); 503 when
// history is off, matching /api/history.
// ============================================================

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 25;
/** Encounters default to close ones: a LEO object collects dozens of wide (40-50 km) box passes per 36 h run.
 *  Override with ?maxMissKm= (up to the screening volumes) and ?limit=. */
const DEFAULT_MAX_MISS_KM = 5;
const OBJECT_EVENT_DAYS = 7;
const OBJECT_EVENT_LIMIT = 50;
const MAX_NORAD = 2_147_483_647;

export interface SsaRouterDeps {
  /** Returns a queryable, or null when history/DB is unavailable. */
  getDb: () => Queryable | null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

function single(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : null; // null = repeated/object param
}

function parseInteger(name: string, raw: unknown, min: number, max: number): Parsed<number | undefined> {
  const s = single(raw);
  if (s === undefined) return { ok: true, value: undefined };
  if (s === null || !/^\d+$/.test(s)) return bad(`Invalid \`${name}\` (expected an integer).`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return bad(`Invalid \`${name}\` (expected ${min}..${max}).`);
  }
  return { ok: true, value: n };
}

function parseNumber(name: string, raw: unknown, min: number, max: number): Parsed<number | undefined> {
  const s = single(raw);
  if (s === undefined) return { ok: true, value: undefined };
  if (s === null || s.trim() === '' || !Number.isFinite(Number(s))) {
    return bad(`Invalid \`${name}\` (expected a number).`);
  }
  const n = Number(s);
  if (n < min || n > max) return bad(`Invalid \`${name}\` (expected ${min}..${max}).`);
  return { ok: true, value: n };
}

function parseDate(name: string, raw: unknown): Parsed<Date | undefined> {
  const s = single(raw);
  if (s === undefined) return { ok: true, value: undefined };
  if (s === null || !/^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(s)) {
    return bad(`Invalid \`${name}\` (expected an ISO date/time).`);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return bad(`Invalid \`${name}\` (expected an ISO date/time).`);
  return { ok: true, value: d };
}

function parseConjunctionQuery(q: Request['query']): Parsed<ConjunctionFilter> {
  const norad = parseInteger('norad', q.norad, 1, MAX_NORAD);
  if (!norad.ok) return norad;
  const from = parseDate('from', q.from);
  if (!from.ok) return from;
  const to = parseDate('to', q.to);
  if (!to.ok) return to;
  if (from.value && to.value && from.value > to.value) return bad('`from` must not be after `to`.');
  const minPc = parseNumber('minPc', q.minPc, 0, 1);
  if (!minPc.ok) return minPc;
  const maxMissKm = parseNumber('maxMissKm', q.maxMissKm, 0, Number.MAX_VALUE);
  if (!maxMissKm.ok) return maxMissKm;
  const limit = parseInteger('limit', q.limit, 1, MAX_LIMIT);
  if (!limit.ok) return limit;
  const sortRaw = single(q.sort);
  if (sortRaw === null || (sortRaw !== undefined && !['tca', 'pc', 'miss'].includes(sortRaw))) {
    return bad('Invalid `sort` (expected tca, pc or miss).');
  }
  return {
    ok: true,
    value: {
      norad: norad.value,
      from: from.value,
      to: to.value,
      minPc: minPc.value,
      maxMissKm: maxMissKm.value ?? DEFAULT_MAX_MISS_KM,
      sort: (sortRaw ?? 'tca') as ConjunctionSort,
      limit: limit.value ?? DEFAULT_LIMIT,
    },
  };
}

function parseEventQuery(q: Request['query']): Parsed<EventFilter> {
  const kind = single(q.kind);
  if (kind === null || (kind !== undefined && !/^[a-z][a-z0-9_]{0,31}$/i.test(kind))) {
    return bad('Invalid `kind`.');
  }
  const since = parseDate('since', q.since);
  if (!since.ok) return since;
  const norad = parseInteger('norad', q.norad, 1, MAX_NORAD);
  if (!norad.ok) return norad;
  const limit = parseInteger('limit', q.limit, 1, MAX_LIMIT);
  if (!limit.ok) return limit;
  return {
    ok: true,
    value: { kind, since: since.value, norad: norad.value, limit: limit.value ?? DEFAULT_LIMIT },
  };
}

function canonicalQuery(req: Request): string {
  const params = new URLSearchParams();
  for (const k of Object.keys(req.query).sort()) {
    const v = req.query[k];
    if (typeof v === 'string') params.append(k, v);
  }
  return `${req.path}?${params.toString()}`;
}

function etagFor(runId: number | null, req: Request): string {
  const h = createHash('sha1').update(`${runId ?? 0}|${canonicalQuery(req)}`).digest('hex').slice(0, 20);
  return `"ssa-${runId ?? 0}-${h}"`;
}

/** Sets cache headers; returns true (and ends the response) when the client's copy is current. */
function notModified(req: Request, res: Response, runId: number | null): boolean {
  const etag = etagFor(runId, req);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('ETag', etag);
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    res.status(304).end();
    return true;
  }
  return false;
}

export function createSsaRouter(deps: SsaRouterDeps): Router {
  const router = Router();

  const unavailable = (res: Response): void => {
    res.status(503).json({ error: 'Encounter data is not available.' });
  };

  /** Wrap a handler: acquire the DB (503 if absent) and map thrown errors to 503. */
  const guarded =
    (label: string, fn: (db: Queryable, req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      const db = deps.getDb();
      if (!db) return unavailable(res);
      try {
        await fn(db, req, res);
      } catch (err) {
        logger.error(`GET /api/ssa${label} failed:`, (err as Error).message);
        if (!res.headersSent) unavailable(res);
      }
    };

  // Validation runs before the DB gate so bad input is a 400 regardless of availability.
  router.get('/run', guarded('/run', async (db, req, res) => {
    const run = await getLatestRun(db);
    if (!run) { res.status(404).json({ error: 'No screening run has completed yet.' }); return; }
    if (notModified(req, res, run.id)) return;
    res.json(run);
  }));

  router.get('/conjunctions', (req, res, next) => {
    const parsed = parseConjunctionQuery(req.query);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    res.locals.filter = parsed.value;
    next();
  }, guarded('/conjunctions', async (db, req, res) => {
    const run = await getLatestRun(db);
    if (!run) { res.status(404).json({ error: 'No screening run has completed yet.' }); return; }
    if (notModified(req, res, run.id)) return;
    const encounters = await listCurrentEncounters(db, run.id, res.locals.filter as ConjunctionFilter);
    const body: SsaConjunctionsResponse = { run, count: encounters.length, encounters };
    res.json(body);
  }));

  router.get('/conjunctions/:id', (req, res, next) => {
    const id = parseInteger('id', req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id.ok) { res.status(400).json({ error: id.error }); return; }
    res.locals.id = id.value;
    next();
  }, guarded('/conjunctions/:id', async (db, req, res) => {
    const run = await getLatestRun(db);
    if (notModified(req, res, run?.id ?? null)) return;
    const detail = await getEncounterDetail(db, res.locals.id as number);
    if (!detail) {
      res.removeHeader('ETag');
      res.removeHeader('Cache-Control');
      res.status(404).json({ error: 'Encounter not found.' });
      return;
    }
    res.json(detail);
  }));

  router.get('/objects/:norad', (req, res, next) => {
    const norad = parseInteger('norad', req.params.norad, 1, MAX_NORAD);
    if (!norad.ok) { res.status(400).json({ error: norad.error }); return; }
    const maxMissKm = parseNumber('maxMissKm', req.query.maxMissKm, 0, Number.MAX_VALUE);
    if (!maxMissKm.ok) { res.status(400).json({ error: maxMissKm.error }); return; }
    const limit = parseInteger('limit', req.query.limit, 1, MAX_LIMIT);
    if (!limit.ok) { res.status(400).json({ error: limit.error }); return; }
    res.locals.norad = norad.value;
    res.locals.maxMissKm = maxMissKm.value ?? DEFAULT_MAX_MISS_KM;
    res.locals.limit = limit.value ?? DEFAULT_LIMIT;
    next();
  }, guarded('/objects/:norad', async (db, req, res) => {
    const noradId = res.locals.norad as number;
    const run = await getLatestRun(db);
    if (notModified(req, res, run?.id ?? null)) return;
    const since = new Date(Date.now() - OBJECT_EVENT_DAYS * 86_400_000);
    const [encounters, events] = await Promise.all([
      run
        ? listCurrentEncounters(db, run.id, {
            norad: noradId, sort: 'tca', maxMissKm: res.locals.maxMissKm as number, limit: res.locals.limit as number,
          })
        : Promise.resolve([]),
      listEvents(db, { norad: noradId, since, limit: OBJECT_EVENT_LIMIT }),
    ]);
    const body: ObjectEncounters = { noradId, run, encounters, events };
    res.json(body);
  }));

  router.get('/events', (req, res, next) => {
    const parsed = parseEventQuery(req.query);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    res.locals.filter = parsed.value;
    next();
  }, guarded('/events', async (db, req, res) => {
    const run = await getLatestRun(db);
    if (notModified(req, res, run?.id ?? null)) return;
    const events = await listEvents(db, res.locals.filter as EventFilter);
    const body: SsaEventsResponse = { count: events.length, events };
    res.json(body);
  }));

  return router;
}

/** Production router: the shared history pool, available only once history is ready. */
const ssaRouter = createSsaRouter({
  getDb: () => (isHistoryReady() ? getPool() : null),
});

export default ssaRouter;
