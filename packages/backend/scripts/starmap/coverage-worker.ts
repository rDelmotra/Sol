// ============================================================
// SPIKE — not production. Workers for the Layer 2 coverage experiment.
//   build  : one SGP4 pass per object per day -> distinct star/Earth cells at all orders
//   refine : exact pass intervals (20 s step + 1 s bisection) for candidate object-days
//   truth  : brute force at a fixed step (no bisection): per object pass counts over India / box B
// ============================================================
import { parentPort } from 'node:worker_threads';
import * as satellite from 'satellite.js';
import {
  cellKey, decodeKey, gmst, geodeticLatAltFromEr, ER_KM, RAD, DEG, SHELL_DELTA0, WGS84_A_KM,
} from '@orbitwatch/orbital-core';
import { makeProp, windowInCap, buildRunsBy, posAt, newStats, NO_CELL, type KeyFn, type Prop } from './runs.js';
import {
  jointKey, jointStar, jointEarth, subPoint, inPoly, groundCell, STAR_RUN_CAP,
  POLY_LAT_MIN, POLY_LAT_MAX, POLY_LON_MIN, POLY_LON_MAX,
} from './coverage-lib.js';

/** hourly: Earth-frame cells only, keyed cell*24+hour, returned in configs 3..5 (orders 4,5,6) */
export interface BuildTask { kind: 'build'; omms: unknown[]; startMs: number; endMs: number; stepMs: number; hourly?: boolean }
export interface BuildOut {
  /** per config (star2,3,4, earth4,5,6): concatenated cells + per-object counts */
  cells: Uint32Array[]; counts: Uint32Array[]; skips: Array<[number, string]>; propCalls: number;
}
export interface RefineTask {
  kind: 'refine'; mode: 'poly' | 'box'; boxOrder: number; boxKey: number; stepMs: number;
  items: Array<{ omm: unknown; startMs: number; endMs: number }>;
}
export interface RefineOut { intervals: Float64Array[]; propCalls: number }
export interface TruthTask { kind: 'truth'; omms: unknown[]; startMs: number; stepMs: number; boxOrder: number; boxKey: number }
export interface TruthOut { india: Uint16Array; box: Uint16Array; propCalls: number }
export type Task = BuildTask | RefineTask | TruthTask;

function build(t: BuildTask): BuildOut {
  const st = newStats();
  const sets: Array<Set<number>> = [new Set(), new Set(), new Set(), new Set(), new Set(), new Set()];
  const cells: number[][] = [[], [], [], [], [], []];
  const counts = Array.from({ length: 6 }, () => new Uint32Array(t.omms.length));
  const skips: Array<[number, string]> = [];
  t.omms.forEach((omm, i) => {
    const p = makeProp(omm);
    if (!p) { skips.push([i, 'bad-elements']); return; }
    if (!windowInCap(p, t.startMs, t.endMs)) { skips.push([i, 'outside-60d-epoch-cap']); return; }
    const runs = buildRunsBy(p, jointKey, t.startMs, t.endMs, t.stepMs, st);
    if (runs.length === 0) { skips.push([i, 'no-valid-position']); return; }
    let starRuns = 0, prevStar = -2;
    const s4 = new Set<number>(), e6 = new Set<number>();
    for (const r of runs) {
      const s = jointStar(r.cell);
      if (s !== prevStar) { starRuns++; prevStar = s; }
      if (s >= 0) s4.add(s);
      e6.add(jointEarth(r.cell));
    }
    if (starRuns > STAR_RUN_CAP) { skips.push([i, `over-row-cap:${starRuns}`]); return; }
    if (t.hourly) {
      const e6h = new Set<number>();
      for (const r of runs) {
        const e = jointEarth(r.cell);
        const h0 = Math.floor((r.tIn - t.startMs) / 3_600_000), h1 = Math.floor((r.tOut - 1 - t.startMs) / 3_600_000);
        for (let h = h0; h <= Math.min(h1, 23); h++) e6h.add(e * 24 + h);
      }
      const e5h = new Set<number>(), e4h = new Set<number>();
      for (const k of e6h) { const h = k % 24, e = (k - h) / 24; const e5 = Math.floor(e / 4); e5h.add(e5 * 24 + h); e4h.add(Math.floor(e5 / 4) * 24 + h); }
      [e4h, e5h, e6h].forEach((set, c) => { counts[3 + c]![i] = set.size; for (const v of set) cells[3 + c]!.push(v); });
      return;
    }
    const s3 = new Set<number>(), s2 = new Set<number>(), e5 = new Set<number>(), e4 = new Set<number>();
    for (const k of s4) { const a = Math.floor(k / 8); s3.add(a); s2.add(Math.floor(a / 8)); }
    for (const k of e6) { const a = Math.floor(k / 4); e5.add(a); e4.add(Math.floor(a / 4)); }
    [s2, s3, s4, e4, e5, e6].forEach((s, c) => { counts[c]![i] = s.size; for (const v of s) cells[c]!.push(v); });
  });
  void sets;
  return { cells: cells.map((a) => Uint32Array.from(a)), counts, skips, propCalls: st.propCalls };
}

/**
 * Refine key = (cell id, pass flag) so the stepped+bisected run builder also splits brackets whose ends
 * sit in different cells (a plain 0/1 membership key cannot see a corner clipped between two outside samples).
 *   poly: key = groundCell@6 * 2 + insidePolygon        pass <=> odd
 *   box : key = star cell id at boxOrder                pass <=> key === boxKey
 */
function refine(t: RefineTask): RefineOut {
  const st = newStats();
  const keyAt: KeyFn = t.mode === 'poly'
    ? (p, tm, s) => { const pos = posAt(p, tm, s); if (!pos) return NO_CELL; const sp = subPoint(pos.x, pos.y, pos.z, tm); return groundCell(6, sp.latDeg, sp.lonDeg) * 2 + (inPoly(sp.latDeg, sp.lonDeg) ? 1 : 0); }
    : (p, tm, s) => { const pos = posAt(p, tm, s); if (!pos) return NO_CELL; return cellKey(t.boxOrder, pos.x, pos.y, pos.z) ?? NO_CELL; };
  const passes = (cell: number) => (t.mode === 'poly' ? cell >= 0 && cell % 2 === 1 : cell === t.boxKey);
  const intervals = t.items.map((it) => {
    const p = makeProp(it.omm);
    if (!p || !windowInCap(p, it.startMs, it.endMs)) return new Float64Array(0);
    const out: number[] = [];
    let open = -1, close = -1;
    for (const r of buildRunsBy(p, keyAt, it.startMs, it.endMs, t.stepMs, st)) {
      if (!passes(r.cell)) continue;
      if (open >= 0 && r.tIn <= close + 1) close = r.tOut; // adjacent runs of one pass (cell changes inside the region)
      else { if (open >= 0) out.push(open, close); open = r.tIn; close = r.tOut; }
    }
    if (open >= 0) out.push(open, close);
    return Float64Array.from(out);
  });
  return { intervals, propCalls: st.propCalls };
}

function truth(t: TruthTask): TruthOut {
  const nSteps = Math.floor(86_400_000 / t.stepMs);
  const cs = new Float64Array(nSteps), sn = new Float64Array(nSteps);
  for (let s = 0; s < nSteps; s++) { const th = gmst(t.startMs + s * t.stepMs); cs[s] = Math.cos(th); sn[s] = Math.sin(th); }
  const { nk } = decodeKey(t.boxOrder, t.boxKey);
  const rLo = WGS84_A_KM * Math.exp((nk * SHELL_DELTA0) / 2 ** t.boxOrder) * (1 - 1e-9);
  const rHi = WGS84_A_KM * Math.exp(((nk + 1) * SHELL_DELTA0) / 2 ** t.boxOrder) * (1 + 1e-9);
  const rLo2 = rLo * rLo, rHi2 = rHi * rHi;
  const sLo = Math.sin((POLY_LAT_MIN - 0.5) * RAD), sHi = Math.sin((POLY_LAT_MAX + 0.5) * RAD);
  const india = new Uint16Array(t.omms.length), box = new Uint16Array(t.omms.length);
  let calls = 0;
  t.omms.forEach((omm, i) => {
    const p = makeProp(omm);
    if (!p || !windowInCap(p, t.startMs, t.startMs + 86_400_000)) return;
    let inInd = false, inBox = false;
    for (let s = 0; s < nSteps; s++) {
      const tm = t.startMs + s * t.stepMs;
      calls++;
      const pv = satellite.sgp4(p.satrec, (tm - p.epochMs) / 60_000);
      const pos = pv ? pv.position : null;
      if (!pos || typeof pos === 'boolean' || !Number.isFinite(pos.x)) { inInd = false; inBox = false; continue; }
      const r2 = pos.x * pos.x + pos.y * pos.y + pos.z * pos.z;
      // box B
      let b = false;
      if (r2 >= rLo2 && r2 < rHi2) b = cellKey(t.boxOrder, pos.x, pos.y, pos.z) === t.boxKey;
      if (b && !inBox) box[i]!++;
      inBox = b;
      // India: geocentric-latitude prefilter (geodetic differs by < 0.2 deg), then exact
      let ind = false;
      const sinLat = pos.z / Math.sqrt(r2);
      if (sinLat >= sLo && sinLat <= sHi) {
        const ex = cs[s]! * pos.x + sn[s]! * pos.y, ey = -sn[s]! * pos.x + cs[s]! * pos.y;
        const lon = Math.atan2(ey, ex) * DEG;
        if (lon >= POLY_LON_MIN - 0.5 && lon <= POLY_LON_MAX + 0.5) {
          const g = geodeticLatAltFromEr({ x: ex / ER_KM, y: ey / ER_KM, z: pos.z / ER_KM });
          ind = inPoly(g.latDeg ?? 0, lon);
        }
      }
      if (ind && !inInd) india[i]!++;
      inInd = ind;
    }
  });
  return { india, box, propCalls: calls };
}

parentPort!.on('message', (m: { id: number; task: Task }) => {
  const t = m.task;
  const out = t.kind === 'build' ? build(t) : t.kind === 'refine' ? refine(t) : truth(t);
  const transfer: ArrayBuffer[] = [];
  if (t.kind === 'build') for (const a of [...(out as BuildOut).cells, ...(out as BuildOut).counts]) transfer.push(a.buffer as ArrayBuffer);
  parentPort!.postMessage({ id: m.id, out }, transfer);
});
void jointKey; void (null as unknown as Prop);
