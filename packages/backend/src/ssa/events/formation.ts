// ============================================================
// close.formation: two objects that stay within 50 km of each other for more than half of a UTC day (a docked stack, a launch
// train, a co-orbiting pair). Ported from the formation part of scripts/starmap/derive-day.ts with the same definition:
//   1. samples every 30 minutes over [day, day + 24 h] (49 samples) with a spatial hash: pairs within FORM_KM at any sample
//   2. for those pairs, the share of 1-minute steps (1440) within FORM_KM; kept when it exceeds FORM_FRAC
// Objects with an unusable satrec or a garbage orbit (radius outside 6340 km..1e6 km at day start, middle or end) and pairs with
// identical element sets (the ISS stack) are left out, as in the spike. Single thread: ~1.6 M + ~0.5 M SGP4 calls.
// ============================================================
import { identicalGroups } from '../encounter.js';
import { makeProp, posAt, type Prop } from './orbit.js';
import { DAY_MS, FORM_FRAC, FORM_KM, type ChangeObject, type EventRow } from './types.js';

const SAMPLE_S = 1800;
const STEP_MS = 60_000;
/** cell index offset / range for the numeric hash key (|coordinate| < 1e6 km at 50 km cells = 2e4 cells) */
const CELL_OFF = 20_001;
const CELL_RANGE = 2 * CELL_OFF + 1;

export interface FormationStats { objects: number; fenced: number; failed: number; candidatePairs: number; pairs: number }

export function deriveFormations(cur: ChangeObject[], dayStartMs: number): { rows: EventRow[]; stats: FormationStats } {
  const t0 = dayStartMs, t1 = t0 + DAY_MS;
  const objs: ChangeObject[] = [];
  const props: Prop[] = [];
  let fenced = 0, failed = 0;
  for (const o of cur) {
    const p = makeProp(o.omm);
    if (!p) { failed++; continue; }
    let bad = false;
    for (const tm of [t0, (t0 + t1) / 2, t1]) {
      const r = posAt(p, tm);
      if (!r) { bad = true; break; }
      const rad = Math.hypot(r[0], r[1], r[2]);
      if (rad < 6340 || rad > 1e6) { bad = true; break; }
    }
    if (bad) { fenced++; continue; }
    objs.push(o); props.push(p);
  }
  const N = objs.length;
  const { group } = identicalGroups(objs);
  const f2 = FORM_KM * FORM_KM;

  // 1. candidate pairs from the half-hourly samples
  const cand = new Set<number>(); // i * N + j, i < j
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N);
  const nSamples = Math.round(DAY_MS / 1000 / SAMPLE_S);
  for (let s = 0; s <= nSamples; s++) {
    const tMs = t0 + s * SAMPLE_S * 1000;
    const cells = new Map<number, number[]>();
    const ci = new Int32Array(N * 3).fill(-1);
    for (let o = 0; o < N; o++) {
      const r = posAt(props[o]!, tMs);
      if (!r) continue;
      px[o] = r[0]; py[o] = r[1]; pz[o] = r[2];
      const ix = Math.floor(r[0] / FORM_KM) + CELL_OFF, iy = Math.floor(r[1] / FORM_KM) + CELL_OFF, iz = Math.floor(r[2] / FORM_KM) + CELL_OFF;
      if (ix < 1 || iy < 1 || iz < 1 || ix >= CELL_RANGE - 1 || iy >= CELL_RANGE - 1 || iz >= CELL_RANGE - 1) continue;
      ci[3 * o] = ix; ci[3 * o + 1] = iy; ci[3 * o + 2] = iz;
      const key = (ix * CELL_RANGE + iy) * CELL_RANGE + iz;
      const l = cells.get(key);
      if (l) l.push(o); else cells.set(key, [o]);
    }
    for (let i = 0; i < N; i++) {
      const ix = ci[3 * i]!;
      if (ix < 0) continue;
      const iy = ci[3 * i + 1]!, iz = ci[3 * i + 2]!;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const l = cells.get(((ix + dx) * CELL_RANGE + (iy + dy)) * CELL_RANGE + (iz + dz));
        if (!l) continue;
        for (const j of l) {
          if (j <= i) continue;
          if (group[i]! >= 0 && group[i] === group[j]) continue;
          const ddx = px[i]! - px[j]!, ddy = py[i]! - py[j]!, ddz = pz[i]! - pz[j]!;
          if (ddx * ddx + ddy * ddy + ddz * ddz <= f2) cand.add(i * N + j);
        }
      }
    }
  }

  // 2. share of the day within FORM_KM, per candidate pair (tracks cached per object)
  const n = Math.floor((t1 - t0) / STEP_MS);
  const tracks = new Map<number, Float64Array>();
  const track = (o: number): Float64Array => {
    let t = tracks.get(o);
    if (!t) {
      t = new Float64Array(n * 3).fill(NaN);
      for (let k = 0; k < n; k++) {
        const r = posAt(props[o]!, t0 + k * STEP_MS);
        if (r) { t[3 * k] = r[0]; t[3 * k + 1] = r[1]; t[3 * k + 2] = r[2]; }
      }
      tracks.set(o, t);
    }
    return t;
  };
  const rows: EventRow[] = [];
  for (const key of cand) {
    const i = Math.floor(key / N), j = key % N;
    const a = track(i), b = track(j);
    let inside = 0, min = Infinity;
    for (let k = 0; k < n; k++) {
      // a failed propagation counts as "far": the spike's distance is Infinity for it
      const d = Math.hypot(a[3 * k]! - b[3 * k]!, a[3 * k + 1]! - b[3 * k + 1]!, a[3 * k + 2]! - b[3 * k + 2]!);
      if (d <= FORM_KM) inside++;
      if (d < min) min = d;
    }
    const frac = inside / n;
    if (frac > FORM_FRAC) rows.push({ kind: 'close.formation', subjects: [objs[i]!.noradId, objs[j]!.noradId].sort((x, y) => x - y), tStart: t0, tEnd: t1, payload: { frac: +frac.toFixed(3), minKm: +min.toFixed(3) } });
  }
  rows.sort((x, y) => x.subjects[0]! - y.subjects[0]! || x.subjects[1]! - y.subjects[1]!);
  return { rows, stats: { objects: N, fenced, failed, candidatePairs: cand.size, pairs: rows.length } };
}
