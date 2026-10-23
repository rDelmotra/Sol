// ============================================================
// SPIKE — not production. Workers for the planner (ask.ts).
//   iss  : closest approach of each object to the ISS track over a window. coarseS = 0 is the brute force
//          (SGP4 every second for every object); coarseS > 0 is the Layer 4 coarse time filter (the same
//          logic as screen-worker.ts issCoarse: SGP4 every coarseS seconds, a relative-speed pad, then 1 s
//          only around the hits).
//   pass : brute force pass intervals over one UTC day at a fixed step (10 s): India polygon and/or the
//          star-map box. Same predicates as coverage-worker.ts truth(), but it returns the pass start/end
//          times and not just flags, so pass times can be compared.
// ============================================================
import { parentPort } from 'node:worker_threads';
import * as satellite from 'satellite.js';
import { cellKey, decodeKey, gmst, geodeticLatAltFromEr, ER_KM, RAD, DEG, SHELL_DELTA0, WGS84_A_KM } from '@orbitwatch/orbital-core';
import { makeProp, windowInCap, type Prop } from './runs.js';
import { inPoly, FENCED, R_MIN_KM, R_MAX_KM, POLY_LAT_MIN, POLY_LAT_MAX, POLY_LON_MIN, POLY_LON_MAX } from './coverage-lib.js';

export interface IssTask {
  kind: 'iss'; omms: unknown[]; base: number; skipIdx: number; t0Ms: number; nSteps: number; iss: Float64Array;
  coarseS: number; R: number; vmax: number;
}
export interface IssOut { res: Float64Array; evals: number }
export interface PassTask {
  kind: 'pass'; omms: unknown[]; norad: number[]; base: number; startMs: number; stepMs: number;
  which: 'india' | 'box' | 'both'; boxOrder: number; boxKey: number;
}
/** passes: flat [globalIdx, kind (0 india, 1 box), startOffsetS, endOffsetS] */
export interface PassOut { passes: Int32Array; propCalls: number }
export type AskTask = IssTask | PassTask;

function sgp(p: Prop, tMs: number, out: Float64Array): boolean {
  const pv = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = pv ? pv.position : null;
  if (!r || typeof r === 'boolean' || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.z)) return false;
  out[0] = r.x; out[1] = r.y; out[2] = r.z;
  return true;
}

function iss(t: IssTask): IssOut {
  const res: number[] = [];
  const tmp = new Float64Array(3);
  const c = t.coarseS;
  const thr = c > 0 ? t.R + (t.vmax * c) / 2 + 1 : Infinity;
  let evals = 0;
  t.omms.forEach((omm, k) => {
    const o = t.base + k;
    if (o === t.skipIdx) return;
    const p = makeProp(omm);
    if (!p) return;
    let best = Infinity, bk = -1;
    const at = (q: number): number => {
      evals++;
      if (!sgp(p, t.t0Ms + q * 1000, tmp)) return Infinity;
      return Math.hypot(tmp[0]! - t.iss[q * 3]!, tmp[1]! - t.iss[q * 3 + 1]!, tmp[2]! - t.iss[q * 3 + 2]!);
    };
    if (c <= 0) {
      for (let q = 0; q < t.nSteps; q++) { const d = at(q); if (d < best) { best = d; bk = q; } }
    } else {
      let last = -1;
      for (let q0 = 0; q0 < t.nSteps; q0 += c) {
        const d0 = at(q0);
        if (d0 > thr) continue;
        const a = Math.max(0, q0 - Math.ceil(c / 2) - 1, last + 1), b = Math.min(t.nSteps - 1, q0 + Math.ceil(c / 2) + 1);
        for (let q = a; q <= b; q++) { const d = q === q0 ? d0 : at(q); if (d < best) { best = d; bk = q; } }
        last = b;
      }
    }
    if (best < t.R) res.push(o, best, bk);
  });
  return { res: Float64Array.from(res), evals };
}

function pass(t: PassTask): PassOut {
  const nSteps = Math.floor(86_400_000 / t.stepMs);
  const cs = new Float64Array(nSteps), sn = new Float64Array(nSteps);
  for (let s = 0; s < nSteps; s++) { const th = gmst(t.startMs + s * t.stepMs); cs[s] = Math.cos(th); sn[s] = Math.sin(th); }
  const wantI = t.which !== 'box', wantB = t.which !== 'india';
  const { nk } = decodeKey(t.boxOrder, t.boxKey);
  const rLo = WGS84_A_KM * Math.exp((nk * SHELL_DELTA0) / 2 ** t.boxOrder) * (1 - 1e-9);
  const rHi = WGS84_A_KM * Math.exp(((nk + 1) * SHELL_DELTA0) / 2 ** t.boxOrder) * (1 + 1e-9);
  const rLo2 = rLo * rLo, rHi2 = rHi * rHi, rMin2 = R_MIN_KM * R_MIN_KM, rMax2 = R_MAX_KM * R_MAX_KM;
  const sLo = Math.sin((POLY_LAT_MIN - 0.5) * RAD), sHi = Math.sin((POLY_LAT_MAX + 0.5) * RAD);
  const out: number[] = [];
  const stepS = t.stepMs / 1000;
  let calls = 0;
  t.omms.forEach((omm, k) => {
    if (FENCED.has(t.norad[k]!)) return;
    const p = makeProp(omm);
    if (!p || !windowInCap(p, t.startMs, t.startMs + 86_400_000)) return;
    const g = t.base + k;
    let iOpen = -1, iLast = -1, bOpen = -1, bLast = -1;
    for (let s = 0; s < nSteps; s++) {
      const tm = t.startMs + s * t.stepMs;
      calls++;
      const pv = satellite.sgp4(p.satrec, (tm - p.epochMs) / 60_000);
      const pos = pv ? pv.position : null;
      let b = false, ind = false;
      if (pos && typeof pos !== 'boolean' && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
        const r2 = pos.x * pos.x + pos.y * pos.y + pos.z * pos.z;
        if (wantB && r2 >= rLo2 && r2 < rHi2) b = cellKey(t.boxOrder, pos.x, pos.y, pos.z) === t.boxKey;
        if (wantI && r2 >= rMin2 && r2 <= rMax2) {
          const sinLat = pos.z / Math.sqrt(r2);
          if (sinLat >= sLo && sinLat <= sHi) {
            const ex = cs[s]! * pos.x + sn[s]! * pos.y, ey = -sn[s]! * pos.x + cs[s]! * pos.y;
            const lon = Math.atan2(ey, ex) * DEG;
            if (lon >= POLY_LON_MIN - 0.5 && lon <= POLY_LON_MAX + 0.5) {
              const gd = geodeticLatAltFromEr({ x: ex / ER_KM, y: ey / ER_KM, z: pos.z / ER_KM });
              ind = inPoly(gd.latDeg ?? 0, lon);
            }
          }
        }
      }
      if (ind) { if (iOpen < 0) iOpen = s; iLast = s; } else if (iOpen >= 0) { out.push(g, 0, iOpen * stepS, iLast * stepS); iOpen = -1; }
      if (b) { if (bOpen < 0) bOpen = s; bLast = s; } else if (bOpen >= 0) { out.push(g, 1, bOpen * stepS, bLast * stepS); bOpen = -1; }
    }
    if (iOpen >= 0) out.push(g, 0, iOpen * stepS, iLast * stepS);
    if (bOpen >= 0) out.push(g, 1, bOpen * stepS, bLast * stepS);
  });
  return { passes: Int32Array.from(out), propCalls: calls };
}

parentPort!.on('message', (m: { id: number; task: AskTask }) => {
  const t = m.task;
  const out = t.kind === 'iss' ? iss(t) : pass(t);
  parentPort!.postMessage({ id: m.id, out });
});
