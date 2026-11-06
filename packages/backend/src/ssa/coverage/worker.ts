// ============================================================
// Worker half of the coverage build and the pass refine (pool: ../pool.ts with workerBase 'coverage/worker'). Tasks:
//   build   ONE SGP4 pass per object over a UTC day (10 s step, box changes bisected to ~1 s) at the star-map order 4, then the visited
//           (cell, period) pairs of the three stored layers: day o3, day o4, hour o4 (order 3 is the exact parent: cell / 8)
//   refine  exact pass intervals on candidate windows ('passes'), or the first in-sample only ('any')
//   brute   fixed-step brute force over a window (no summaries, no bisection): the independent check for recall / precision
// Satellites are only ever keyed in the star map (TEME). Ground questions use the exact sub-satellite point inside the region, which
// is answering, not indexing.
// ============================================================
import { parentPort } from 'node:worker_threads';
import { makeProp, buildRunsBy, cellAt, newStats, windowInCap, type Prop, type RunStats } from './runs.js';
import { FENCED, STAR_FINE, STAR_RUN_CAP, ID_SHIFT, HOUR_MS } from './consts.js';
import { passesIn, anyPassIn, regionFlags, NO_TIME } from './scan.js';
import type { Region } from './region.js';
import type { PropagatorKind } from '../encounter.js';

export interface BuildTask {
  kind: 'build'; omms: unknown[]; norad: number[]; base: number; startMs: number; endMs: number; stepMs: number; /** false: skip the hour.o4 pairs (default true) */ hourly?: boolean;
  /** propagation model per object (same order as omms); absent or a missing entry = SGP4. Only the history backfill sets it. */
  props?: Array<PropagatorKind | null>;
}
export interface BuildOut {
  /** key * ID_SHIFT + global object index, unsorted, for [day o3, day o4, hour o4] */
  pairs: Float64Array[];
  /** [local index, reason] of objects that are not indexed */
  skips: Array<[number, string]>;
  propCalls: number;
}
export interface RefineTask { kind: 'refine'; region: Region; mode: 'passes' | 'any'; items: Array<{ omm: unknown; windows: number[]; /** absent = SGP4 */ propagator?: PropagatorKind }> }
/** passes: per item [start, end, ...]; any: per item [t] or [] */
export interface RefineOut { intervals: Float64Array[]; propCalls: number }
export interface BruteTask { kind: 'brute'; region: Region; omms: unknown[]; norad: number[]; startMs: number; endMs: number; stepMs: number; props?: Array<PropagatorKind | null> }
export type Task = BuildTask | RefineTask | BruteTask | { kind: 'init' };

const sortUnique = (a: Float64Array): Float64Array => {
  a.sort();
  let w = 0;
  for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[i - 1]) a[w++] = a[i]!;
  return a.subarray(0, w);
};

function build(t: BuildTask): BuildOut {
  const st = newStats();
  const pairs: number[][] = [[], [], []];
  const skips: Array<[number, string]> = [];
  const keyAt = (p: Prop, tm: number, s: RunStats) => cellAt(p, STAR_FINE, tm, s);
  t.omms.forEach((omm, i) => {
    if (FENCED.has(t.norad[i]!)) { skips.push([i, 'fenced']); return; }
    const p = makeProp(omm, t.props?.[i] ?? undefined);
    if (!p) { skips.push([i, 'bad-elements']); return; }
    if (!windowInCap(p, t.startMs, t.endMs)) { skips.push([i, 'outside-60d-epoch-cap']); return; }
    const runs = buildRunsBy(p, keyAt, t.startMs, t.endMs, t.stepMs, st);
    if (runs.length === 0) { skips.push([i, 'no-valid-position']); return; }
    let starRuns = 0, prev = -2;
    for (const r of runs) if (r.cell !== prev) { starRuns++; prev = r.cell; }
    if (starRuns > STAR_RUN_CAP) { skips.push([i, `over-row-cap:${starRuns}`]); return; }
    // (cell4, hour) pairs; +-1 s margin so a run ending exactly on an hour boundary touches both periods
    const hours: number[] = [], cells4: number[] = [];
    const wantHours = t.hourly !== false;
    for (const r of runs) {
      if (wantHours) {
        const h0 = Math.max(0, Math.floor((r.tIn - 1000 - t.startMs) / HOUR_MS));
        const h1 = Math.min(23, Math.floor((r.tOut + 1000 - t.startMs) / HOUR_MS));
        for (let h = h0; h <= h1; h++) hours.push(r.cell * 24 + h);
      }
      cells4.push(r.cell);
    }
    const idx = t.base + i;
    const hu = sortUnique(Float64Array.from(hours));
    const c4 = sortUnique(Float64Array.from(cells4));
    const c3 = sortUnique(Float64Array.from(cells4, (c) => Math.floor(c / 8)));
    for (let k = 0; k < c3.length; k++) pairs[0]!.push(c3[k]! * ID_SHIFT + idx);
    for (let k = 0; k < c4.length; k++) pairs[1]!.push(c4[k]! * ID_SHIFT + idx);
    for (let k = 0; k < hu.length; k++) pairs[2]!.push(hu[k]! * ID_SHIFT + idx);
  });
  return { pairs: pairs.map((a) => Float64Array.from(a)), skips, propCalls: st.propCalls };
}

function refine(t: RefineTask): RefineOut {
  const st = newStats();
  const intervals = t.items.map((it) => {
    const p = makeProp(it.omm, it.propagator);
    if (!p) return new Float64Array(0);
    if (t.mode === 'any') { const tm = anyPassIn(p, t.region, it.windows, st); return tm !== NO_TIME ? Float64Array.of(tm) : new Float64Array(0); }
    return Float64Array.from(passesIn(p, t.region, it.windows, st));
  });
  return { intervals, propCalls: st.propCalls };
}

/** Brute force: every object at a fixed step over the window; per object the runs of consecutive inside samples as [first, last, ...]. */
function brute(t: BruteTask): RefineOut {
  const st = newStats();
  const flags = regionFlags(t.region, st);
  const intervals = t.omms.map((omm, i) => {
    if (FENCED.has(t.norad[i]!)) return new Float64Array(0);
    const p = makeProp(omm, t.props?.[i] ?? undefined);
    if (!p || !windowInCap(p, t.startMs, t.endMs)) return new Float64Array(0);
    const out: number[] = [];
    let open = NaN, last = NaN; // NaN, not -1: instants before 1970 are negative
    for (let tm = t.startMs; tm < t.endMs; tm += t.stepMs) {
      if (flags(p, tm).inside) { if (Number.isNaN(open)) open = tm; last = tm; }
      else if (!Number.isNaN(open)) { out.push(open, last); open = NaN; }
    }
    if (!Number.isNaN(open)) out.push(open, last);
    return Float64Array.from(out);
  });
  return { intervals, propCalls: st.propCalls };
}

parentPort!.on('message', (m: { id: number; msg: Task }) => {
  const t = m.msg;
  if (t.kind === 'init') { parentPort!.postMessage({ id: m.id, out: true }); return; }
  const out = t.kind === 'build' ? build(t) : t.kind === 'refine' ? refine(t) : brute(t);
  const transfer: ArrayBuffer[] = [];
  if (t.kind === 'build') for (const a of (out as BuildOut).pairs) transfer.push(a.buffer as ArrayBuffer);
  else for (const a of (out as RefineOut).intervals) if (a.buffer.byteLength) transfer.push(a.buffer as ArrayBuffer);
  parentPort!.postMessage({ id: m.id, out }, transfer);
});
