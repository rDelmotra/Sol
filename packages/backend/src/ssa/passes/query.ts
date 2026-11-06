// ============================================================
// Ground passes over time: who passed over a region between two instants, and when.
//
//   passedOverSet(pool, region, from, to)     the objects with at least one pass (cheap: candidates from the star-map lists, then the
//                                              first in-sample of each candidate; an object already found is not looked at again on
//                                              later days)
//   passesOver(pool, region, from, to, opts)   the same set plus the pass intervals (1 s) of the first `limit` objects by NORAD id
//
// "Passed over" = the sub-satellite point (geodetic latitude, longitude) is inside the region (polygon or circle) at a sample, for an
// object inside the star map's radial range: exactly the spike's definition. Candidates come from the day's coverage lists with the
// region rotated into the star map per period (cover.ts); they miss nothing at the build's 10-second resolution; shorter visits are
// found only by the exact refine, which samples at 20 s and at 1 s wherever the object is within 3 degrees of the region.
// Each day is refined with the element sets the lists were built from (omm_updates as of the end of that day).
// ============================================================
import { cpus } from 'node:os';
import type { Pool } from 'pg';
import { WorkerPool } from '../pool.js';
import { coverageDir, coverageWorkers, historyPaths, historyPathsFrom, type HistoryPaths } from '../config.js';
import { loadOmmCatalog, loadNames, isoDay, type OmmObject } from '../coverage/catalog.js';
import { getHistoryStore } from '../history/store.js';
import type { PropagatorKind } from '../encounter.js';
import { DAY_MS } from '../coverage/consts.js';
import type { Region } from '../coverage/region.js';
import { readManifest, type Manifest } from '../coverage/store.js';
import type { RefineOut, RefineTask } from '../coverage/worker.js';
import { chooseLayer, dayCandidates, wholeDayWindows, type DayCandidates } from './candidates.js';
import { LruCache } from './lru.js';

export const MAX_WINDOW_DAYS = 90;
/** At most this many missing days are computed on the fly by brute force (when the caller asks for it); the rest are only listed. */
export const MAX_FILL_DAYS = 2;
const REFINE_CHUNK = 50;

export const GUARANTEE = 'The star-map lists miss nothing at 10-second resolution; shorter visits are found only by the exact refine, which resolves passes to 1 second.';

export interface PassesOpts {
  /** coverage directory (default SSA_COVERAGE_DIR) */
  dir?: string;
  /**
   * History root (default SSA_HISTORY_DIR; null = none): days without a coverage manifest in `dir` are looked up in <root>/coverage, and
   * those days are refined with the element sets of <root>/elsets (and the manifest's SGP list) instead of omm_updates.
   */
  historyDir?: string | HistoryPaths | null;
  /** objects to return passes for, lowest NORAD id first (default 50; 0 = only the total) */
  limit?: number;
  /** only this object */
  norad?: number;
  /** compute up to MAX_FILL_DAYS days without coverage by brute force (needs element sets in the database) */
  fill?: boolean;
  workers?: number;
  /** now, UTC ms: the window is clipped to it (a pass that has not happened yet is not a pass) */
  nowMs?: number;
  onProgress?: (msg: string) => void;
}

export interface ObjectPasses { noradId: number; passes: Array<[startMs: number, endMs: number]> }
export interface PassesResult {
  fromMs: number;
  toMs: number;
  /** true when the window was cut at `now` */
  clippedToNow: boolean;
  /** objects with at least one pass (all of them, whatever `limit` is) */
  totalObjects: number;
  objects: ObjectPasses[];
  missingDays: string[];
  filledDays: string[];
  /** per day: the layer used */
  layers: Record<string, string>;
  stats: { days: number; candidateObjectDays: number; refinedObjectDays: number; wallS: number; coverS: number; loadS: number; refineS: number };
}

export class PassesError extends Error {
  constructor(readonly code: 'bad-window' | 'too-long' | 'busy', message: string) { super(message); }
}

export function validateWindow(fromMs: number, toMs: number): void {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new PassesError('bad-window', 'from and to must be valid instants');
  if (toMs <= fromMs) throw new PassesError('bad-window', '`to` must be after `from`');
  if (toMs - fromMs > MAX_WINDOW_DAYS * DAY_MS) throw new PassesError('too-long', `the window may be at most ${MAX_WINDOW_DAYS} days`);
}

const daysOf = (fromMs: number, toMs: number): string[] => {
  const out: string[] = [];
  for (let t = Math.floor(fromMs / DAY_MS) * DAY_MS; t < toMs; t += DAY_MS) out.push(isoDay(t));
  return out;
};

// ---------------------------------------------------------------- caches
/** Passes of one object on one day, per (region, day, window clip): past days do not change, so a refined object is never refined twice. */
const detailCache = new LruCache<string, number[]>(200_000);
/** Whole-answer cache for windows that end before today: kept a day when complete, five minutes when days are missing (coverage may arrive). */
const resultCache = new LruCache<string, { res: PassesResultWithIds; expiresAt: number }>(64);
export function clearPassesCaches(): void { detailCache.clear(); resultCache.clear(); }

// ---------------------------------------------------------------- worker pool lifecycle (one query at a time uses the pool)
class Refiner {
  private pool: WorkerPool | null = null;
  constructor(private readonly workers: number) {}
  async run(region: Region, mode: 'any' | 'passes', items: Array<{ norad: number; omm: unknown; windows: number[]; propagator?: PropagatorKind }>): Promise<Map<number, Float64Array>> {
    const out = new Map<number, Float64Array>();
    if (!items.length) return out;
    if (!this.pool) { this.pool = new WorkerPool(this.workers, 'coverage/worker'); await this.pool.start({ kind: 'init' }); }
    const tasks: RefineTask[] = [];
    for (let b = 0; b < items.length; b += REFINE_CHUNK) {
      tasks.push({ kind: 'refine', region, mode, items: items.slice(b, b + REFINE_CHUNK).map((x) => ({ omm: x.omm, windows: x.windows, ...(x.propagator ? { propagator: x.propagator } : {}) })) });
    }
    const res = await this.pool.map<RefineOut>(tasks);
    res.forEach((r, ti) => r.intervals.forEach((iv, k) => out.set(items[ti * REFINE_CHUNK + k]!.norad, iv)));
    return out;
  }
  async close(): Promise<void> { if (this.pool) { await this.pool.close(); this.pool = null; } }
}

/** The element sets a day is refined with: history days from the element-set files (the manifest's SGP list says which are SGP), else omm_updates. */
async function loadDayOmms(pool: Pool, plan: DayPlan, ids: readonly number[]): Promise<Map<number, OmmObject>> {
  if (!plan.history) return new Map((await loadOmmCatalog(pool, plan.day, ids)).map((x) => [x.noradId, x]));
  const want = new Set(ids);
  const sgp = new Set(plan.manifest?.propagators?.sgp ?? []);
  const out = new Map<number, OmmObject>();
  for (const o of getHistoryStore(plan.history).dayCatalog(plan.day)) {
    if (!want.has(o.noradId)) continue;
    out.set(o.noradId, { noradId: o.noradId, omm: o.omm, ...(sgp.has(o.noradId) ? { propagator: 'sgp' as PropagatorKind } : {}) });
  }
  return out;
}

interface DayPlan {
  day: string;
  dayStartMs: number;
  manifest: Manifest | null;
  /** brute-force day (no coverage, filled on the fly) */
  brute: boolean;
  /** directory whose <day>/ holds this day's coverage files */
  dir: string;
  /** history root when the day comes from the history backfill (elements from its element-set files), else null */
  history: HistoryPaths | null;
}

/** Candidate windows keyed by NORAD id for a day. */
function candidatesByNorad(plan: DayPlan, region: Region, fromMs: number, toMs: number, only: ReadonlySet<number> | undefined, bruteIds: number[] | undefined, st: { coverS: number }): { windows: Map<number, number[]>; layer: string } | null {
  const t0 = performance.now();
  try {
    if (plan.brute) {
      const ids = bruteIds ?? [];
      const w = wholeDayWindows(plan.dayStartMs, fromMs, toMs, ids);
      const out = new Map<number, number[]>();
      for (const [nd, ww] of w) if (!only || only.has(nd)) out.set(nd, ww);
      return { windows: out, layer: 'brute-force' };
    }
    const m = plan.manifest!;
    const dir = plan.dir;
    const dl = chooseLayer(dir, m);
    if (!dl) return null;
    let onlyIdx: Set<number> | undefined;
    if (only) { onlyIdx = new Set(); m.norad.forEach((nd, i) => { if (only.has(nd)) onlyIdx!.add(i); }); }
    const c: DayCandidates = dayCandidates(dir, m, region, fromMs, toMs, dl, onlyIdx);
    const out = new Map<number, number[]>();
    for (const [i, w] of c.windows) out.set(m.norad[i]!, w);
    return { windows: out, layer: `${dl.gran}.o${dl.layer.order}` };
  } finally { st.coverS += (performance.now() - t0) / 1000; }
}

interface Ctx {
  pool: Pool; region: Region; fromMs: number; toMs: number; refiner: Refiner;
  plans: DayPlan[]; missing: string[]; filled: string[]; layers: Record<string, string>;
  st: PassesResult['stats'];
  log: (m: string) => void;
}

async function plan(pool: Pool, dir: string, hist: HistoryPaths | null, fromMs: number, toMs: number, fill: boolean, nowMs: number): Promise<{ plans: DayPlan[]; missing: string[]; filled: string[] }> {
  const plans: DayPlan[] = [], missing: string[] = [], filled: string[] = [];
  const days = daysOf(fromMs, toMs);
  for (const day of days) {
    const dayStartMs = Date.parse(day + 'T00:00:00Z');
    const m = readManifest(dir, day);
    if (m && chooseLayer(dir, m)) { plans.push({ day, dayStartMs, manifest: m, brute: false, dir, history: null }); continue; }
    // not in the live coverage directory: the history backfill's, if there is one
    const hc = hist?.coverage ?? null;
    const hm = hc ? readManifest(hc, day) : null;
    if (hm && hc && chooseLayer(hc, hm)) { plans.push({ day, dayStartMs, manifest: hm, brute: false, dir: hc, history: hist }); continue; }
    missing.push(day);
  }
  if (fill && missing.length > 0 && missing.length <= MAX_FILL_DAYS) {
    for (const day of [...missing]) {
      // the day must have element sets to propagate (the catalog as of the end of that day), and must have begun
      const dayStartMs = Date.parse(day + 'T00:00:00Z');
      if (dayStartMs >= nowMs) continue;
      const has = await pool.query('SELECT 1 FROM omm_updates WHERE epoch < to_timestamp($1::float8 / 1000.0) LIMIT 1', [dayStartMs + DAY_MS]);
      if (!has.rowCount) continue;
      plans.push({ day, dayStartMs, manifest: null, brute: true, dir, history: null });
      filled.push(day); missing.splice(missing.indexOf(day), 1);
    }
    plans.sort((a, b) => a.day.localeCompare(b.day));
  }
  return { plans, missing, filled };
}

/** Phase A: the objects with at least one pass, oldest day first, skipping objects already found. */
async function findObjects(c: Ctx, only: ReadonlySet<number> | undefined): Promise<Set<number>> {
  const found = new Set<number>();
  let prefetch: { day: string; p: Promise<Map<number, OmmObject>> } | null = null;
  const loadFor = async (plan: DayPlan, wanted: number[]): Promise<Map<number, OmmObject>> => {
    const t0 = performance.now();
    const rows = await loadDayOmms(c.pool, plan, wanted);
    c.st.loadS += (performance.now() - t0) / 1000;
    return rows;
  };
  const cands: Array<{ plan: DayPlan; windows: Map<number, number[]> } | null> = [];
  for (let k = 0; k < c.plans.length; k++) {
    const plan = c.plans[k]!;
    let bruteIds: number[] | undefined;
    if (plan.brute) bruteIds = (await loadOmmCatalog(c.pool, plan.day, only ? [...only] : undefined)).map((r) => r.noradId);
    const r = candidatesByNorad(plan, c.region, c.fromMs, c.toMs, only, bruteIds, c.st);
    if (r) c.layers[plan.day] = r.layer;
    cands.push(r ? { plan, windows: r.windows } : null);
  }
  for (let k = 0; k < cands.length; k++) {
    const cd = cands[k];
    if (!cd) continue;
    const { plan, windows } = cd;
    const todo = [...windows.keys()].filter((nd) => !found.has(nd));
    c.st.candidateObjectDays += windows.size;
    if (!todo.length) continue;
    const omms = await (prefetch && prefetch.day === plan.day ? prefetch.p : loadFor(plan, todo));
    prefetch = null;
    // overlap the next day's catalog read with this day's refine
    const nx = cands.slice(k + 1).find((x) => x);
    if (nx) {
      const w = [...nx.windows.keys()].filter((nd) => !found.has(nd));
      const p = loadFor(nx.plan, w);
      p.catch(() => undefined); // a failure surfaces where the prefetch is awaited (next day), never as an unhandled rejection meanwhile
      prefetch = { day: nx.plan.day, p };
    }
    const items = todo.filter((nd) => omms.has(nd)).map((nd) => ({ norad: nd, omm: omms.get(nd)!.omm, windows: windows.get(nd)!, ...(omms.get(nd)!.propagator ? { propagator: omms.get(nd)!.propagator! } : {}) }));
    c.st.refinedObjectDays += items.length;
    const t0 = performance.now();
    const res = await c.refiner.run(c.region, 'any', items);
    c.st.refineS += (performance.now() - t0) / 1000;
    let add = 0;
    for (const [nd, iv] of res) if (iv.length) { found.add(nd); add++; }
    c.log(`${plan.day}: ${windows.size} candidates, ${items.length} refined, +${add} objects (${found.size} total)`);
    // the prefetched catalog was keyed to the objects not found BEFORE this day; harmless if some are now found
  }
  return found;
}

/** Phase B: all passes of the chosen objects. */
async function passesOfObjects(c: Ctx, chosen: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>(chosen.map((n) => [n, []]));
  if (!chosen.length) return out;
  const want = new Set(chosen);
  const keyBase = `${c.region.id}|`;
  for (const plan of c.plans) {
    const dayFrom = Math.max(c.fromMs, plan.dayStartMs), dayTo = Math.min(c.toMs, plan.dayStartMs + DAY_MS);
    const clip = `${plan.day}|${dayFrom}|${dayTo}|`;
    const need: number[] = [];
    for (const nd of chosen) {
      const hit = detailCache.get(`${keyBase}${clip}${nd}`);
      if (hit) out.get(nd)!.push(...hit); else need.push(nd);
    }
    if (!need.length) continue;
    const bruteIds = plan.brute ? need : undefined;
    const r = candidatesByNorad(plan, c.region, c.fromMs, c.toMs, new Set(need), bruteIds, c.st);
    if (!r) continue;
    c.layers[plan.day] ??= r.layer;
    const wantedIds = [...r.windows.keys()].filter((nd) => want.has(nd));
    const omms = await loadDayOmms(c.pool, plan, wantedIds);
    const items = wantedIds.filter((nd) => omms.has(nd)).map((nd) => ({ norad: nd, omm: omms.get(nd)!.omm, windows: r.windows.get(nd)!, ...(omms.get(nd)!.propagator ? { propagator: omms.get(nd)!.propagator! } : {}) }));
    c.st.refinedObjectDays += items.length;
    const t0 = performance.now();
    const res = await c.refiner.run(c.region, 'passes', items);
    c.st.refineS += (performance.now() - t0) / 1000;
    for (const nd of need) {
      const iv = res.get(nd);
      const arr = iv ? Array.from(iv) : [];
      detailCache.set(`${keyBase}${clip}${nd}`, arr, arr.length + 4);
      out.get(nd)!.push(...arr);
    }
  }
  return out;
}

/** Join pass pieces that touch across a day boundary (the end of one day's last sample and the start of the next day's first). */
export function mergePieces(flat: number[], gapMs = 2000): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i]!, flat[i + 1]!]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const p of pairs) {
    const last = out[out.length - 1];
    if (last && p[0] - last[1] <= gapMs) last[1] = Math.max(last[1], p[1]); else out.push([p[0], p[1]]);
  }
  return out;
}

async function setup(pool: Pool, region: Region, fromMs: number, toMs: number, o: PassesOpts): Promise<{ c: Ctx; clipped: boolean; toMs: number } | { empty: true; clipped: boolean }> {
  const nowMs = o.nowMs ?? Date.now();
  validateWindow(fromMs, toMs);
  let clipped = false;
  if (toMs > nowMs) { toMs = nowMs; clipped = true; }
  if (toMs <= fromMs) return { empty: true, clipped };
  const dir = o.dir ?? coverageDir();
  const hist = o.historyDir === undefined ? historyPaths() : typeof o.historyDir === 'string' ? historyPathsFrom(o.historyDir) : o.historyDir;
  const { plans, missing, filled } = await plan(pool, dir, hist, fromMs, toMs, o.fill === true, nowMs);
  const refiner = new Refiner(o.workers ?? coverageWorkers(cpus().length));
  const c: Ctx = { pool, region, fromMs, toMs, refiner, plans, missing, filled, layers: {}, st: { days: plans.length, candidateObjectDays: 0, refinedObjectDays: 0, wallS: 0, coverS: 0, loadS: 0, refineS: 0 }, log: o.onProgress ?? (() => undefined) };
  return { c, clipped, toMs };
}

const empty = (fromMs: number, toMs: number, clipped: boolean): PassesResult => ({
  fromMs, toMs, clippedToNow: clipped, totalObjects: 0, objects: [], missingDays: [], filledDays: [], layers: {},
  stats: { days: 0, candidateObjectDays: 0, refinedObjectDays: 0, wallS: 0, coverS: 0, loadS: 0, refineS: 0 },
});

// ---------------------------------------------------------------- single-flight: one heavy query at a time, the same query shares its result
const inflight = new Map<string, Promise<unknown>>();
let running = false;
const queue: Array<() => void> = [];
const MAX_QUEUE = 4;
async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const have = inflight.get(key);
  if (have) return have as Promise<T>;
  const p = (async () => {
    if (running) {
      if (queue.length >= MAX_QUEUE) throw new PassesError('busy', 'too many pass queries are running; try again shortly');
      await new Promise<void>((res) => queue.push(res)); // the slot is handed over: `running` stays true
    } else running = true;
    try { return await fn(); } finally { const next = queue.shift(); if (next) next(); else running = false; }
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

/** The objects with at least one pass over `region` in [fromMs, toMs). */
export async function passedOverSet(pool: Pool, region: Region, fromMs: number, toMs: number, o: PassesOpts = {}): Promise<{ ids: Set<number>; missingDays: string[]; filledDays: string[]; clippedToNow: boolean; stats: PassesResult['stats'] }> {
  const { norad: _unused, ...rest } = o; void _unused;
  const r = await passesOver(pool, region, fromMs, toMs, { ...rest, limit: 0 });
  return { ids: new Set(r.allIds ?? []), missingDays: r.missingDays, filledDays: r.filledDays, clippedToNow: r.clippedToNow, stats: r.stats };
}

export interface PassesResultWithIds extends PassesResult { allIds?: number[] }

/** Who passed over `region` in [fromMs, toMs) and when (the first `limit` objects by NORAD id carry their pass intervals). */
export async function passesOver(pool: Pool, region: Region, fromMs: number, toMs: number, o: PassesOpts = {}): Promise<PassesResultWithIds> {
  const key = `${region.id}|${fromMs}|${toMs}|${o.limit ?? 50}|${o.norad ?? ''}|${o.fill ? 1 : 0}`;
  return exclusive(key, async () => {
    const T = performance.now();
    const nowMs = o.nowMs ?? Date.now();
    const s = await setup(pool, region, fromMs, toMs, o);
    if ('empty' in s) return empty(fromMs, toMs, s.clipped);
    const { c, clipped } = s;
    const cacheKey = `${key}|${s.toMs}`;
    const cacheable = s.toMs <= Math.floor(nowMs / DAY_MS) * DAY_MS;
    if (cacheable) { const hit = resultCache.get(cacheKey); if (hit && hit.expiresAt > Date.now()) return hit.res; }
    try {
      const only = o.norad !== undefined ? new Set([o.norad]) : undefined;
      const found = await findObjects(c, only);
      const sorted = [...found].sort((a, b) => a - b);
      const limit = o.limit ?? 50;
      const chosen = o.norad !== undefined ? sorted : sorted.slice(0, limit);
      const detail = limit === 0 && o.norad === undefined ? new Map<number, number[]>() : await passesOfObjects(c, chosen);
      c.st.wallS = +((performance.now() - T) / 1000).toFixed(2);
      const res: PassesResultWithIds = {
        fromMs, toMs: s.toMs, clippedToNow: clipped, totalObjects: found.size,
        objects: chosen.filter((nd) => detail.has(nd)).map((nd) => ({ noradId: nd, passes: mergePieces(detail.get(nd)!) })),
        missingDays: c.missing, filledDays: c.filled, layers: c.layers, stats: c.st, allIds: sorted,
      };
      if (cacheable) resultCache.set(cacheKey, { res, expiresAt: Date.now() + (c.missing.length === 0 ? DAY_MS : 5 * 60_000) });
      return res;
    } finally {
      await c.refiner.close();
    }
  });
}

export { loadNames };
