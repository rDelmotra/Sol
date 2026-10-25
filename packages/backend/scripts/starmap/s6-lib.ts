// ============================================================
// SPIKE — not production. S6 (faster, industry-shaped 36 h screener): the pure pieces, unit-tested in s6-lib.test.ts.
//   1. Space Flight Safety Handbook screening volumes (RIC boxes by the primary's orbit regime) and the membership test.
//   2. The conservative bound that lets the coarse stage step 30-60 s instead of 5 s without missing a pair (see "THE BOUND").
//   3. Radius-range sampling for the apogee-perigee pre-filter (measured radii, padded) and the shell-overlap pair counts.
//   4. Local-minimum finder for the refinement (sign change of r.v, then root polishing).
// Everything is TEME km, km/s, seconds unless stated. No SGP4 here: callers pass state functions.
//
// THE BOUND (coarse stage, window of half-width h around a sample time t_k).
//   Let r(t), w(t) be the relative position and velocity of two objects, a(t) = d2r/dt2 their relative acceleration,
//   and let a_max bound |a(t)| for t in [t_k - h, t_k + h]. Then, with r, w the exact SGP4 values at t_k and tau = t - t_k,
//        r(t) = r + w tau + e(tau),   |e| <= eps = a_max h^2 / 2,    |w(t) - w| <= eps_v = a_max h.
//   (a) Position. Every point the pair can occupy in the window lies within eps of the straight segment {r + w tau}.
//   (b) Where a local minimum can be. A local minimum of |r(t)| at t* has r(t*).w(t*) = 0. Write s = t* - tau0 where tau0 is
//       the foot of the straight line (m = |r + w tau0| its miss, m perpendicular to w). Then
//           |w|^2 s = -(w.e + m.e_v + e.e_v + s w.e_v)   =>   |s| <= (|w| eps + m eps_v + eps eps_v) / (|w| (|w| - eps_v)),
//       valid when |w| > eps_v (otherwise the whole window is possible). So the minimum point lies on the piece of the segment with
//       |tau - tau0| <= lambda, widened by eps in every direction.
//   (c) Frame. The volume is in the RIC frame of the primary at the time of the minimum. The frame is predicted at the middle of the
//       piece (two-body, error << 1e-4 rad) and turns by at most omega * (piece half-length) from there; this widens each axis by
//       |p| (omega hl + BASIS_ERR), |p| <= the volume's half-diagonal + eps.
//   A window is a CANDIDATE if the piece, as a segment in the primary's frame, meets the volume box widened by those pads. Because
//   the pads are upper bounds, a local minimum inside the volume cannot be dropped: the test never says "no" for a true encounter.
//   (d) a_max. The relative acceleration of two bodies in the same gravity field is the field difference plus unmodelled terms:
//           a_max = 2.3 mu / r_f^3 * D  +  0.011 mu / r_f^2
//       with r_f a lower bound of both radii in the window, D a bound of their separation in the window (closed form in
//       `maxSeparation`), 2 mu/r^3 the largest eigenvalue of the gravity gradient (x1.15 for J2 and the chord), and 1.1% of local
//       gravity for what SGP4 adds (short-period terms, drag, solar/lunar). The 1.1% is an ASSUMPTION; `s6-bound-check.ts`
//       measures the actual extrapolation error of real pairs against eps and the unit test checks it on synthetic orbits.
//   (e) Gathering. The grid must hand the test every pair that could pass it: |r| <= rho + |w| h with rho the widened volume's
//       half-diagonal. `solveCell` finds the cell size L that covers this for the fastest pair of the pass.
// ============================================================
import { ricBasis, toRic, type RicBasis, type V3 } from '@orbitwatch/orbital-core';

export const MU = 398600.4418;
export const RE_KM = 6378.137;
export const GRAD_FACTOR = 2.3;
export const NONGRAV_FRAC = 0.011;
export const BASIS_ERR = 3e-5; // rad: frame prediction error + SGP4 osculating-frame jitter

// ---------------- screening volumes ----------------
export interface Volume { id: number; u: number; v: number; w: number; name: string }
/** Table 3 of the 2026 TraCSS/Aerospace Conjunction Screening Testset Users Guide (SFS Handbook v1.7). Half-extents in km. */
export const SFS_VOLUMES: Volume[] = [
  { id: 1, u: 10, v: 10, w: 10, name: 'deep space (GEO-like)' },
  { id: 2, u: 0.4, v: 2, w: 2, name: 'LEO4' },
  { id: 3, u: 0.4, v: 12, w: 12, name: 'LEO3' },
  { id: 4, u: 0.4, v: 25, w: 25, name: 'LEO2' },
  { id: 5, u: 0.4, v: 44, w: 51, name: 'LEO1' },
  { id: 6, u: 20, v: 20, w: 20, name: 'other deep space' },
  { id: 7, u: 2, v: 25, w: 25, name: 'other near Earth' },
  { id: 8, u: 20, v: 50, w: 20, name: 'hyperbolic' },
];
export const volumeById = (id: number): Volume => SFS_VOLUMES[id - 1]!;

export interface OrbitShape { periodMin: number; ecc: number; incDeg: number; perigeeKm: number }
export function shapeFromOmm(omm: Record<string, unknown>): OrbitShape {
  const n = Number(omm.MEAN_MOTION), ecc = Number(omm.ECCENTRICITY), incDeg = Number(omm.INCLINATION);
  const periodMin = 1440 / n;
  const a = Math.cbrt(MU / ((n * 2 * Math.PI) / 86400) ** 2);
  return { periodMin, ecc, incDeg, perigeeKm: a * (1 - ecc) - RE_KM };
}
/** Volume id (1-8) by the primary's regime, from its mean elements. */
export function volumeIdFor(s: OrbitShape): number {
  if (s.ecc >= 1) return 8;
  if (s.periodMin > 1300 && s.periodMin < 1800 && s.ecc < 0.25 && s.incDeg < 35) return 1;
  if (s.ecc < 0.25) {
    if (s.perigeeKm <= 500) return 5;
    if (s.perigeeKm <= 750) return 4;
    if (s.perigeeKm <= 1200) return 3;
    if (s.perigeeKm <= 2000) return 2;
  }
  return s.periodMin > 225 ? 6 : 7;
}
/** Radius (km) of the sphere that contains a volume box. */
export const halfDiagonal = (v: { u: number; v: number; w: number }): number => Math.hypot(v.u, v.v, v.w);
export const inBox = (ric: V3, v: { u: number; v: number; w: number }): boolean => Math.abs(ric[0]) <= v.u && Math.abs(ric[1]) <= v.v && Math.abs(ric[2]) <= v.w;
export const inEllipsoid = (ric: V3, v: { u: number; v: number; w: number }): boolean => (ric[0] / v.u) ** 2 + (ric[1] / v.v) ** 2 + (ric[2] / v.w) ** 2 <= 1;

// ---------------- the bound ----------------
const gradK = (rFloor: number): number => (GRAD_FACTOR * MU) / rFloor ** 3;
const nongC = (rFloor: number): number => (NONGRAV_FRAC * MU) / rFloor ** 2;
/** Upper bound of |relative acceleration| (km/s^2) for two bodies at least rFloor from Earth's centre and at most D apart. */
export const relAccelBound = (D: number, rFloor: number): number => gradK(rFloor) * D + nongC(rFloor);
/** Upper bound of the separation anywhere in a window of half-width h, given |r| = r0 and |w| = w0 at its centre (closed form). */
export function maxSeparation(r0: number, w0: number, h: number, rFloor: number): number {
  const hh = 0.5 * h * h, den = 1 - gradK(rFloor) * hh;
  if (den < 0.2) return Infinity;
  return (r0 + w0 * h + nongC(rFloor) * hh) / den;
}

const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface WindowArgs {
  /** secondary minus primary at the sample, and relative velocity */
  r: V3; w: V3;
  /** primary state at the sample (to predict its RIC frame) */
  pa: V3; va: V3;
  /** window half-width, s */
  h: number;
  /** bound of the relative acceleration in the window, km/s^2 */
  aRel: number;
  /** bound of the rotation rate of the primary's RIC frame, rad/s */
  omega: number;
  /** volume half-extents (radial, in-track, cross-track), km */
  half: V3;
}

/** Segment p0 + q u, u in [0, T], against the axis-aligned box |x_k| <= H_k. */
function segmentMeetsBox(p0: V3, q: V3, T: number, H: V3): boolean {
  let lo = 0, hi = T;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(q[k]!) < 1e-15) { if (Math.abs(p0[k]!) > H[k]!) return false; continue; }
    let a = (-H[k]! - p0[k]!) / q[k]!, b = (H[k]! - p0[k]!) / q[k]!;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > lo) lo = a;
    if (b < hi) hi = b;
    if (lo > hi) return false;
  }
  return true;
}

/** Bound of |t* - tau0| for a local minimum t* (see THE BOUND (b)); Infinity when the window cannot exclude anything. */
export function minimumOffsetBound(wn: number, m: number, eps: number, epsV: number): number {
  if (!(wn > 2 * epsV)) return Infinity;
  return (wn * eps + m * epsV + eps * epsV) / (wn * (wn - epsV));
}

/**
 * True if a local minimum of the miss distance inside the primary's volume (box `half`) may occur in [-h, h] around the sample.
 * Conservative: false only when no true encounter in the window can exist (given the acceleration bound `aRel`).
 */
export function windowCandidate(a: WindowArgs): boolean {
  const { r, w, h } = a;
  const w2 = dot3(w, w), wn = Math.sqrt(w2);
  const eps = 0.5 * a.aRel * h * h, epsV = a.aRel * h;
  const rw = dot3(r, w);
  const tau0 = w2 > 1e-18 ? -rw / w2 : 0;
  const mx = r[0] + w[0] * tau0, my = r[1] + w[1] * tau0, mz = r[2] + w[2] * tau0;
  const m = Math.sqrt(mx * mx + my * my + mz * mz);
  const lam = minimumOffsetBound(wn, m, eps, epsV);
  const lo = Math.max(-h, tau0 - lam), hi = Math.min(h, tau0 + lam);
  if (lo > hi) return false;
  const hl = 0.5 * (hi - lo), tc = 0.5 * (lo + hi);
  // primary's RIC frame at the middle of the piece, two-body prediction
  const pr = Math.hypot(a.pa[0], a.pa[1], a.pa[2]), g = MU / (pr * pr * pr);
  const rA: V3 = [a.pa[0] + a.va[0] * tc - 0.5 * g * a.pa[0] * tc * tc, a.pa[1] + a.va[1] * tc - 0.5 * g * a.pa[1] * tc * tc, a.pa[2] + a.va[2] * tc - 0.5 * g * a.pa[2] * tc * tc];
  const vA: V3 = [a.va[0] - g * a.pa[0] * tc, a.va[1] - g * a.pa[1] * tc, a.va[2] - g * a.pa[2] * tc];
  const B = ricBasis(rA, vA);
  if (!B) return true;
  const rho = Math.hypot(a.half[0], a.half[1], a.half[2]) + eps;
  const pad = eps + rho * (a.omega * hl + BASIS_ERR);
  const H: V3 = [a.half[0] + pad, a.half[1] + pad, a.half[2] + pad];
  const pLo: V3 = [r[0] + w[0] * lo, r[1] + w[1] * lo, r[2] + w[2] * lo];
  return segmentMeetsBox(toRic(pLo, B), toRic(w, B), hi - lo, H);
}

export interface PassBound {
  /** gather radius = grid cell size, km */
  L: number;
  /** bound of the position extrapolation error for any gathered pair, km */
  epsCap: number;
  /** bound of the frame-rotation pad, km */
  padCap: number;
}
/** Cell size that gathers every pair `windowCandidate` could accept in a pass (see THE BOUND (e)); fixed point of L = rho + |w| h. */
export function solveCell(p: { hrMax: number; wMax: number; rFloor: number; omegaMax: number; h: number }): PassBound {
  let L = p.hrMax + p.wMax * p.h + 5, epsCap = 0, padCap = 0;
  for (let it = 0; it < 30; it++) {
    const D = maxSeparation(L, p.wMax, p.h, p.rFloor);
    if (!Number.isFinite(D)) return { L: Infinity, epsCap: Infinity, padCap: Infinity };
    const a = relAccelBound(D, p.rFloor);
    epsCap = 0.5 * a * p.h * p.h;
    padCap = epsCap + (p.hrMax + epsCap) * (p.omegaMax * p.h + BASIS_ERR);
    const Ln = p.hrMax + padCap + p.wMax * p.h + 1;
    if (Math.abs(Ln - L) < 0.01) { L = Ln; break; }
    L = Ln;
  }
  return { L, epsCap, padCap };
}

// ---------------- apogee-perigee pre-filter: measured radius ranges ----------------
/** Bound of |d2 r/dt2| (km/s^2) of the radius of a near-Kepler orbit: (mu/r^2)(e cos nu) plus 2% of gravity for perturbations. */
export const radialCurvatureBound = (rMin: number, ecc: number): number => (MU / (rMin * rMin)) * (Math.min(1, ecc) + 0.02);
/** Sample spacing (s) such that the radius between samples cannot dip below the sampled extremes by more than padKm. */
export const radiusSpacing = (K: number, padKm: number): number => Math.sqrt((8 * padKm) / K);
export const radiusPad = (K: number, spacing: number): number => (K * spacing * spacing) / 8;

export interface ShellCounts {
  total: number; // unordered pairs
  overlap: number; // pairs whose [rlo-R, rhi+R] intervals meet
  noPartner: number; // objects with no overlapping partner at all
}
/** Counts by sorted-array binary search, O(N log N): pairs of objects whose radius ranges come within R of each other. */
export function shellCounts(rlo: Float64Array, rhi: Float64Array, R: number, groupA?: Uint8Array, groupB?: number): { cross: number; perObject: Int32Array } {
  // number of partners of each object i among objects of class groupB (all if groupA undefined)
  const idx: number[] = [];
  for (let i = 0; i < rlo.length; i++) if (!groupA || groupA[i] === groupB) idx.push(i);
  const lo = Float64Array.from(idx.map((i) => rlo[i]!)).sort(), hi = Float64Array.from(idx.map((i) => rhi[i]!)).sort();
  const upper = (a: Float64Array, x: number): number => { let l = 0, h = a.length; while (l < h) { const m = (l + h) >> 1; if (a[m]! <= x) l = m + 1; else h = m; } return l; };
  const lower = (a: Float64Array, x: number): number => { let l = 0, h = a.length; while (l < h) { const m = (l + h) >> 1; if (a[m]! < x) l = m + 1; else h = m; } return l; };
  const per = new Int32Array(rlo.length);
  let cross = 0;
  for (let i = 0; i < rlo.length; i++) {
    // partners j with rlo_j <= rhi_i + R and rhi_j >= rlo_i - R
    const c = upper(lo, rhi[i]! + R) - lower(hi, rlo[i]! - R);
    per[i] = c;
    cross += c;
  }
  return { cross, perObject: per };
}

// ---------------- local minima of the miss distance ----------------
export interface RelState { r: V3; v: V3 }
/**
 * Times (ms) of the local minima of |r(t)| in [ta, tb]: sign changes of f = r.v from negative to non-negative on a grid of
 * `stepMs`, each polished by the Illinois method to `tolMs`. `rel(t)` returns the relative state or null on failure.
 */
export function findMinima(rel: (tMs: number) => RelState | null, ta: number, tb: number, stepMs: number, tolMs = 1): number[] {
  const n = Math.max(1, Math.ceil((tb - ta) / stepMs));
  const dt = (tb - ta) / n;
  const out: number[] = [];
  const f = (t: number): number => { const s = rel(t); return s ? dot3(s.r, s.v) : NaN; };
  let tPrev = ta, fPrev = f(ta);
  for (let k = 1; k <= n; k++) {
    const t = ta + k * dt, ft = f(t);
    if (fPrev < 0 && ft >= 0) {
      let a = tPrev, b = t, fa = fPrev, fb = ft, side = 0;
      for (let it = 0; it < 60 && b - a > tolMs; it++) {
        const c = fb === fa ? 0.5 * (a + b) : (a * fb - b * fa) / (fb - fa);
        const fc = f(c);
        if (!(fc === fc)) break;
        if (fc * fb > 0) { b = c; fb = fc; if (side === -1) fa *= 0.5; side = -1; }
        else if (fa * fc > 0) { a = c; fa = fc; if (side === 1) fb *= 0.5; side = 1; }
        else { a = b = c; break; }
      }
      out.push(0.5 * (a + b));
    }
    tPrev = t; fPrev = ft;
  }
  return out;
}

export { ricBasis, toRic };
export type { RicBasis, V3 };
