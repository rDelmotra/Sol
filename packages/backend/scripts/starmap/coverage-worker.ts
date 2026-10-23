// ============================================================
// SPIKE — not production. Workers for the Layer 2 star-map coverage experiment.
//   build  : ONE SGP4 pass per object per day (order-4 star box, 20 s step, bisected to ~1 s), then the
//            visited (cell, period) pairs at 3 granularities x 3 orders (orders 3, 2 are exact parents)
//   refine : exact pass intervals on candidate windows (20 s step; 1 s step wherever the object is near
//            the target so no graze shorter than 1 s can slip between two samples)
//   truth  : brute force at a fixed step (no bisection, no summaries), all objects
// Satellites are only ever keyed in the star map (TEME). Ground questions use the exact sub-satellite
// point inside the polygon, which is answering, not indexing.
// ============================================================
import { parentPort } from 'node:worker_threads';
import * as satellite from 'satellite.js';
import {
  cellKey, decodeKey, gmst, geodeticLatAltFromEr, ER_KM, RAD, DEG, SHELL_DELTA0, WGS84_A_KM,
} from '@orbitwatch/orbital-core';
import { makeProp, windowInCap, buildRunsBy, cellAt, posAt, newStats, type Prop, type RunStats } from './runs.js';
import { scanWindow, type Flags } from './coverage-scan.js';
import {
  subPoint, inPoly, STAR_RUN_CAP, FENCED, STAR_FINE, STAR_ORDERS, GRANS, ID_SHIFT, R_MIN_KM, R_MAX_KM,
  POLY_LAT_MIN, POLY_LAT_MAX, POLY_LON_MIN, POLY_LON_MAX,
} from './coverage-lib.js';

const N_CFG = GRANS.length * STAR_ORDERS.length; // config index = gran * 3 + orderIdx

export interface BuildTask { kind: 'build'; omms: unknown[]; norad: number[]; base: number; startMs: number; endMs: number; stepMs: number }
export interface BuildOut {
  /** per config (gran-major, then order 2,3,4): key * 65536 + global object index, unsorted */
  pairs: Float64Array[]; skips: Array<[number, string]>; propCalls: number; noCell: number;
}
export interface BoxSpec { order: number; key: number; rLo: number; rHi: number; cx: number; cy: number; cz: number; hwRad: number }
export interface RefineTask {
  kind: 'refine'; mode: 'poly' | 'box'; box: BoxSpec; stepMs: number; nearStepMs: number;
  items: Array<{ omm: unknown; windows: number[] }>; // windows: flat [startMs, endMs, ...]
}
export interface RefineOut { intervals: Float64Array[]; propCalls: number }
export interface TruthTask { kind: 'truth'; omms: unknown[]; norad: number[]; startMs: number; stepMs: number; boxOrder: number; boxKey: number }
export interface TruthOut { india: Uint16Array; box: Uint16Array; indiaMask: Uint8Array; boxMask: Uint8Array; propCalls: number }
export type Task = BuildTask | RefineTask | TruthTask;

const sortUnique = (a: Float64Array | Uint32Array): Float64Array | Uint32Array => {
  a.sort();
  let w = 0;
  for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[i - 1]) a[w++] = a[i]!;
  return a.subarray(0, w);
};

function build(t: BuildTask): BuildOut {
  const st = newStats();
  const pairs: number[][] = Array.from({ length: N_CFG }, () => []);
  const skips: Array<[number, string]> = [];
  const keyAt = (p: Prop, tm: number, s: RunStats) => cellAt(p, STAR_FINE, tm, s);
  const P10 = 600_000;
  t.omms.forEach((omm, i) => {
    if (FENCED.has(t.norad[i]!)) { skips.push([i, 'fenced']); return; }
    const p = makeProp(omm);
    if (!p) { skips.push([i, 'bad-elements']); return; }
    if (!windowInCap(p, t.startMs, t.endMs)) { skips.push([i, 'outside-60d-epoch-cap']); return; }
    const runs = buildRunsBy(p, keyAt, t.startMs, t.endMs, t.stepMs, st);
    if (runs.length === 0) { skips.push([i, 'no-valid-position']); return; }
    let starRuns = 0, prev = -2;
    for (const r of runs) if (r.cell !== prev) { starRuns++; prev = r.cell; }
    if (starRuns > STAR_RUN_CAP) { skips.push([i, `over-row-cap:${starRuns}`]); return; }
    // (cell4, 10-min period) pairs; +-1 s margin so a run ending exactly on a boundary touches both periods
    const raw: number[] = [];
    for (const r of runs) {
      const p0 = Math.max(0, Math.floor((r.tIn - 1000 - t.startMs) / P10));
      const p1 = Math.min(143, Math.floor((r.tOut + 1000 - t.startMs) / P10));
      for (let q = p0; q <= p1; q++) raw.push(r.cell * 144 + q);
    }
    const m10 = sortUnique(Uint32Array.from(raw)) as Uint32Array;
    for (let g = 0; g < GRANS.length; g++) {
      const per = 144 / GRANS[g]!.perDay;
      for (let o = 0; o < STAR_ORDERS.length; o++) {
        const shift = 8 ** (STAR_FINE - STAR_ORDERS[o]!);
        const vals = new Uint32Array(m10.length);
        for (let k = 0; k < m10.length; k++) {
          const cell = Math.floor(m10[k]! / 144), q = m10[k]! % 144;
          vals[k] = Math.floor(cell / shift) * GRANS[g]!.perDay + Math.floor(q / per);
        }
        const u = sortUnique(vals);
        const dst = pairs[g * STAR_ORDERS.length + o]!;
        const idx = t.base + i;
        for (let k = 0; k < u.length; k++) dst.push(u[k]! * ID_SHIFT + idx);
      }
    }
  });
  return { pairs: pairs.map((a) => Float64Array.from(a)), skips, propCalls: st.propCalls, noCell: st.noCell };
}

// ---------------------------------------------------------------- refine
const NONE: Flags = { inside: false, near: false };
const NEAR_DEG = 3;
const BOX_NEAR_RAD = (5 * Math.PI) / 180;
const BOX_NEAR_KM = 150;

function flagsFn(t: RefineTask, st: RunStats): (p: Prop, tm: number) => Flags {
  if (t.mode === 'poly') {
    return (p, tm) => {
      const pos = posAt(p, tm, st);
      if (!pos) return NONE;
      const r = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
      if (r < R_MIN_KM || r > R_MAX_KM) return NONE;
      const sp = subPoint(pos.x, pos.y, pos.z, tm);
      const inside = inPoly(sp.latDeg, sp.lonDeg);
      const near = inside || (sp.latDeg >= POLY_LAT_MIN - NEAR_DEG && sp.latDeg <= POLY_LAT_MAX + NEAR_DEG &&
        sp.lonDeg >= POLY_LON_MIN - NEAR_DEG && sp.lonDeg <= POLY_LON_MAX + NEAR_DEG);
      return { inside, near };
    };
  }
  const b = t.box;
  return (p, tm) => {
    const pos = posAt(p, tm, st);
    if (!pos) return NONE;
    const r = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
    if (r < R_MIN_KM || r > R_MAX_KM) return NONE;
    const inside = cellKey(b.order, pos.x, pos.y, pos.z) === b.key;
    if (inside) return { inside, near: true };
    if (r < b.rLo - BOX_NEAR_KM || r > b.rHi + BOX_NEAR_KM) return NONE;
    const dot = (pos.x * b.cx + pos.y * b.cy + pos.z * b.cz) / r;
    return { inside, near: Math.acos(Math.min(1, dot)) <= b.hwRad + BOX_NEAR_RAD };
  };
}

function refine(t: RefineTask): RefineOut {
  const st = newStats();
  const flags = flagsFn(t, st);
  const intervals = t.items.map((it) => {
    const p = makeProp(it.omm);
    const out: number[] = [];
    if (!p) return new Float64Array(0);
    for (let w = 0; w < it.windows.length; w += 2) {
      const a = it.windows[w]!, b = it.windows[w + 1]!;
      if (!windowInCap(p, a, b)) continue;
      scanWindow(p, a, b, t.stepMs, t.nearStepMs, flags, out);
    }
    return Float64Array.from(out);
  });
  return { intervals, propCalls: st.propCalls };
}

// ---------------------------------------------------------------- truth
function truth(t: TruthTask): TruthOut {
  const nSteps = Math.floor(86_400_000 / t.stepMs);
  const cs = new Float64Array(nSteps), sn = new Float64Array(nSteps);
  for (let s = 0; s < nSteps; s++) { const th = gmst(t.startMs + s * t.stepMs); cs[s] = Math.cos(th); sn[s] = Math.sin(th); }
  const { nk } = decodeKey(t.boxOrder, t.boxKey);
  const rLo = WGS84_A_KM * Math.exp((nk * SHELL_DELTA0) / 2 ** t.boxOrder) * (1 - 1e-9);
  const rHi = WGS84_A_KM * Math.exp(((nk + 1) * SHELL_DELTA0) / 2 ** t.boxOrder) * (1 + 1e-9);
  const rLo2 = rLo * rLo, rHi2 = rHi * rHi, rMin2 = R_MIN_KM * R_MIN_KM, rMax2 = R_MAX_KM * R_MAX_KM;
  const sLo = Math.sin((POLY_LAT_MIN - 0.5) * RAD), sHi = Math.sin((POLY_LAT_MAX + 0.5) * RAD);
  const n = t.omms.length;
  const india = new Uint16Array(n), box = new Uint16Array(n);
  const indiaMask = new Uint8Array(n * 144), boxMask = new Uint8Array(n * 144);
  const stepsPer10 = 600_000 / t.stepMs;
  let calls = 0;
  t.omms.forEach((omm, i) => {
    if (FENCED.has(t.norad[i]!)) return;
    const p = makeProp(omm);
    if (!p || !windowInCap(p, t.startMs, t.startMs + 86_400_000)) return;
    let inInd = false, inBox = false;
    for (let s = 0; s < nSteps; s++) {
      const tm = t.startMs + s * t.stepMs;
      calls++;
      const pv = satellite.sgp4(p.satrec, (tm - p.epochMs) / 60_000);
      const pos = pv ? pv.position : null;
      if (!pos || typeof pos === 'boolean' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) { inInd = false; inBox = false; continue; }
      const r2 = pos.x * pos.x + pos.y * pos.y + pos.z * pos.z;
      const q = Math.floor(s / stepsPer10);
      let b = false;
      if (r2 >= rLo2 && r2 < rHi2) b = cellKey(t.boxOrder, pos.x, pos.y, pos.z) === t.boxKey;
      if (b) { if (!inBox) box[i]!++; boxMask[i * 144 + q] = 1; }
      inBox = b;
      let ind = false;
      if (r2 >= rMin2 && r2 <= rMax2) {
        const sinLat = pos.z / Math.sqrt(r2);
        if (sinLat >= sLo && sinLat <= sHi) {
          const ex = cs[s]! * pos.x + sn[s]! * pos.y, ey = -sn[s]! * pos.x + cs[s]! * pos.y;
          const lon = Math.atan2(ey, ex) * DEG;
          if (lon >= POLY_LON_MIN - 0.5 && lon <= POLY_LON_MAX + 0.5) {
            const g = geodeticLatAltFromEr({ x: ex / ER_KM, y: ey / ER_KM, z: pos.z / ER_KM });
            ind = inPoly(g.latDeg ?? 0, lon);
          }
        }
      }
      if (ind) { if (!inInd) india[i]!++; indiaMask[i * 144 + q] = 1; }
      inInd = ind;
    }
  });
  return { india, box, indiaMask, boxMask, propCalls: calls };
}

parentPort!.on('message', (m: { id: number; task: Task }) => {
  const t = m.task;
  const out = t.kind === 'build' ? build(t) : t.kind === 'refine' ? refine(t) : truth(t);
  const transfer: ArrayBuffer[] = [];
  if (t.kind === 'build') for (const a of (out as BuildOut).pairs) transfer.push(a.buffer as ArrayBuffer);
  parentPort!.postMessage({ id: m.id, out }, transfer);
});
