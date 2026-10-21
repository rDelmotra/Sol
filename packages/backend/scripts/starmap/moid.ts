// ============================================================
// SPIKE — not production.
//
// MOID: minimum distance between two orbit ellipses treated as FIXED wires.
// Method: coarse N x N sampling of the eccentric anomalies, find the local minima of the
// sampled distance, then polish the best few with damped Newton (closed-form gradient and
// Hessian; the second derivative of a point on an ellipse is -(x - centre)).
// A wire is 9 numbers: point(E) = C + cos(E) AP + sin(E) BQ  (C = -a e P, AP = a P, BQ = b Q).
// ============================================================

import { basis, type Elements } from './invariants.js';

export type Wire = Float64Array; // [Cx,Cy,Cz, APx,APy,APz, BQx,BQy,BQz]
export const COARSE_N = 72;
const TWO_PI = 2 * Math.PI;

/** The wire of an element set at time tMs (J2 drift applied). */
export function wireFromElements(el: Elements, tMs: number, out: Wire = new Float64Array(9)): Wire {
  const { P, Q } = basis(el, tMs);
  const b = el.a * Math.sqrt(1 - el.e * el.e);
  for (let k = 0; k < 3; k++) {
    out[k] = -el.a * el.e * P[k];
    out[3 + k] = el.a * P[k];
    out[6 + k] = b * Q[k];
  }
  return out;
}

export function wirePoint(w: Wire, E: number, out: Float64Array | number[] = [0, 0, 0]): Float64Array | number[] {
  const c = Math.cos(E), s = Math.sin(E);
  out[0] = w[0]! + c * w[3]! + s * w[6]!;
  out[1] = w[1]! + c * w[4]! + s * w[7]!;
  out[2] = w[2]! + c * w[5]! + s * w[8]!;
  return out;
}

const COS = new Float64Array(COARSE_N), SIN = new Float64Array(COARSE_N);
for (let i = 0; i < COARSE_N; i++) { COS[i] = Math.cos((TWO_PI * i) / COARSE_N); SIN[i] = Math.sin((TWO_PI * i) / COARSE_N); }

/** N points of the wire at uniform eccentric anomaly (N = COARSE_N). */
export function sampleWire(w: Wire, out: Float64Array = new Float64Array(COARSE_N * 3)): Float64Array {
  for (let i = 0; i < COARSE_N; i++) {
    const c = COS[i]!, s = SIN[i]!;
    out[i * 3] = w[0]! + c * w[3]! + s * w[6]!;
    out[i * 3 + 1] = w[1]! + c * w[4]! + s * w[7]!;
    out[i * 3 + 2] = w[2]! + c * w[5]! + s * w[8]!;
  }
  return out;
}

const D2 = new Float64Array(COARSE_N * COARSE_N);

export interface MoidResult { dist: number; e1: number; e2: number }

/** Polish a starting (E1,E2) to a local minimum of the squared distance. */
function polish(a: Float64Array, oa: number, b: Float64Array, ob: number, E1: number, E2: number): MoidResult {
  let lam = 1e-3;
  const f = (e1: number, e2: number) => {
    const c1 = Math.cos(e1), s1 = Math.sin(e1), c2 = Math.cos(e2), s2 = Math.sin(e2);
    const dx = a[oa + 0]! + c1 * a[oa + 3]! + s1 * a[oa + 6]! - (b[ob + 0]! + c2 * b[ob + 3]! + s2 * b[ob + 6]!);
    const dy = a[oa + 1]! + c1 * a[oa + 4]! + s1 * a[oa + 7]! - (b[ob + 1]! + c2 * b[ob + 4]! + s2 * b[ob + 7]!);
    const dz = a[oa + 2]! + c1 * a[oa + 5]! + s1 * a[oa + 8]! - (b[ob + 2]! + c2 * b[ob + 5]! + s2 * b[ob + 8]!);
    return dx * dx + dy * dy + dz * dz;
  };
  let fc = f(E1, E2);
  for (let it = 0; it < 60; it++) {
    const c1 = Math.cos(E1), s1 = Math.sin(E1), c2 = Math.cos(E2), s2 = Math.sin(E2);
    // x1 - C1, x2 - C2
    const u1x = c1 * a[oa + 3]! + s1 * a[oa + 6]!, u1y = c1 * a[oa + 4]! + s1 * a[oa + 7]!, u1z = c1 * a[oa + 5]! + s1 * a[oa + 8]!;
    const u2x = c2 * b[ob + 3]! + s2 * b[ob + 6]!, u2y = c2 * b[ob + 4]! + s2 * b[ob + 7]!, u2z = c2 * b[ob + 5]! + s2 * b[ob + 8]!;
    const dx = a[oa + 0]! + u1x - (b[ob + 0]! + u2x), dy = a[oa + 1]! + u1y - (b[ob + 1]! + u2y), dz = a[oa + 2]! + u1z - (b[ob + 2]! + u2z);
    // tangents
    const t1x = -s1 * a[oa + 3]! + c1 * a[oa + 6]!, t1y = -s1 * a[oa + 4]! + c1 * a[oa + 7]!, t1z = -s1 * a[oa + 5]! + c1 * a[oa + 8]!;
    const t2x = -s2 * b[ob + 3]! + c2 * b[ob + 6]!, t2y = -s2 * b[ob + 4]! + c2 * b[ob + 7]!, t2z = -s2 * b[ob + 5]! + c2 * b[ob + 8]!;
    const g1 = 2 * (dx * t1x + dy * t1y + dz * t1z);
    const g2 = -2 * (dx * t2x + dy * t2y + dz * t2z);
    const h11 = 2 * (t1x * t1x + t1y * t1y + t1z * t1z) - 2 * (dx * u1x + dy * u1y + dz * u1z);
    const h22 = 2 * (t2x * t2x + t2y * t2y + t2z * t2z) + 2 * (dx * u2x + dy * u2y + dz * u2z);
    const h12 = -2 * (t1x * t2x + t1y * t2y + t1z * t2z);
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const A = h11 + lam * (Math.abs(h11) + 1), D = h22 + lam * (Math.abs(h22) + 1);
      const det = A * D - h12 * h12;
      if (det > 0 && A > 0) {
        const s1d = -(D * g1 - h12 * g2) / det, s2d = -(-h12 * g1 + A * g2) / det;
        const fn = f(E1 + s1d, E2 + s2d);
        if (fn <= fc) {
          E1 += s1d; E2 += s2d;
          const done = Math.abs(s1d) + Math.abs(s2d) < 1e-12 || fc - fn < 1e-18 * (1 + fc);
          fc = fn; lam = Math.max(lam / 4, 1e-12); improved = true;
          if (done) return { dist: Math.sqrt(fc), e1: E1, e2: E2 };
          break;
        }
      }
      lam *= 8;
    }
    if (!improved) break;
  }
  return { dist: Math.sqrt(fc), e1: E1, e2: E2 };
}

/** Counters for the diagnostics (how many coarse local minima were polished). */
export const moidStats = { pairs: 0, polished: 0 };

/**
 * MOID of two prepared wires (wire + its COARSE_N sampled points), read at offsets into packed arrays
 * (wire: 9 numbers at oa/ob, samples: COARSE_N*3 at sa/sb). Every coarse local minimum whose sampled
 * distance can still hide a deeper basin (<= best polished + pi*(a1+a2)/N, the largest distance the
 * nearest grid sample can overstate a basin by) is polished with damped Newton, in ascending order.
 * `stopBelow`: return as soon as a polished distance <= stopBelow (the caller only needs "MOID <= x").
 * Not re-entrant (shared scratch).
 */
export function moidPacked(W1: Float64Array, oa: number, S1: Float64Array, sa: number, W2: Float64Array, ob: number, S2: Float64Array, sb: number, stopBelow = -1): MoidResult {
  const N = COARSE_N;
  for (let i = 0; i < N; i++) {
    const ax = S1[sa + i * 3]!, ay = S1[sa + i * 3 + 1]!, az = S1[sa + i * 3 + 2]!;
    const row = i * N;
    for (let j = 0; j < N; j++) {
      const dx = ax - S2[sb + j * 3]!, dy = ay - S2[sb + j * 3 + 1]!, dz = az - S2[sb + j * 3 + 2]!;
      D2[row + j] = dx * dx + dy * dy + dz * dz;
    }
  }
  // local minima (4-neighbour, cyclic), kept ascending in a small array
  let nm = 0;
  for (let i = 0; i < N; i++) {
    const im = (i + N - 1) % N, ip = (i + 1) % N;
    for (let j = 0; j < N; j++) {
      const v = D2[i * N + j]!;
      const jm = (j + N - 1) % N, jp = (j + 1) % N;
      if (v > D2[im * N + j]! || v > D2[ip * N + j]! || v > D2[i * N + jm]! || v > D2[i * N + jp]!) continue;
      if (nm === MAXMIN && v >= MV[nm - 1]!) continue;
      let k = nm < MAXMIN ? nm++ : nm - 1;
      while (k > 0 && MV[k - 1]! > v) { MV[k] = MV[k - 1]!; MI[k] = MI[k - 1]!; k--; }
      MV[k] = v; MI[k] = i * N + j;
    }
  }
  const aa = Math.hypot(W1[oa + 3]!, W1[oa + 4]!, W1[oa + 5]!), ab = Math.hypot(W2[ob + 3]!, W2[ob + 4]!, W2[ob + 5]!);
  const slack = (Math.PI * (aa + ab)) / N;
  let best: MoidResult = { dist: Infinity, e1: 0, e2: 0 };
  moidStats.pairs++;
  for (let k = 0; k < nm; k++) {
    if (Math.sqrt(MV[k]!) > best.dist + slack) break;
    const i = Math.floor(MI[k]! / N), j = MI[k]! % N;
    moidStats.polished++;
    const r = polish(W1, oa, W2, ob, (TWO_PI * i) / N, (TWO_PI * j) / N);
    if (r.dist < best.dist) best = r;
    if (best.dist <= stopBelow) break;
  }
  return best;
}
const MAXMIN = 64;
const MV = new Float64Array(MAXMIN), MI = new Int32Array(MAXMIN);

export function moidPrepared(wa: Wire, sa: Float64Array, wb: Wire, sb: Float64Array, stopBelow = -1): MoidResult {
  return moidPacked(wa, 0, sa, 0, wb, 0, sb, 0, stopBelow);
}

/** Convenience: MOID of two element sets at time tMs (prepares the wires itself). */
export function moid(a: Elements, b: Elements, tMs: number): MoidResult {
  const wa = wireFromElements(a, tMs), wb = wireFromElements(b, tMs);
  return moidPrepared(wa, sampleWire(wa), wb, sampleWire(wb));
}

/** Brute force MOID on an n x n eccentric-anomaly grid (reference; O(n^2)). */
export function moidBrute(wa: Wire, wb: Wire, n: number): number {
  const pa = new Float64Array(n * 3), pb = new Float64Array(n * 3);
  const t = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    wirePoint(wa, (TWO_PI * i) / n, t); pa.set(t, i * 3);
    wirePoint(wb, (TWO_PI * i) / n, t); pb.set(t, i * 3);
  }
  let m = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = pa[i * 3]!, ay = pa[i * 3 + 1]!, az = pa[i * 3 + 2]!;
    for (let j = 0; j < n; j++) {
      const dx = ax - pb[j * 3]!, dy = ay - pb[j * 3 + 1]!, dz = az - pb[j * 3 + 2]!;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < m) m = d;
    }
  }
  return Math.sqrt(m);
}

/** Distance (km) from a point to the wire (nearest point of the ellipse). */
export function distToWire(w: Wire, px: number, py: number, pz: number): number {
  const f = (E: number) => {
    const c = Math.cos(E), s = Math.sin(E);
    const dx = w[0]! + c * w[3]! + s * w[6]! - px, dy = w[1]! + c * w[4]! + s * w[7]! - py, dz = w[2]! + c * w[5]! + s * w[8]! - pz;
    return dx * dx + dy * dy + dz * dz;
  };
  // start from the point's own angle in the (scaled) orbit plane
  const qx = px - w[0]!, qy = py - w[1]!, qz = pz - w[2]!;
  const a2 = w[3]! * w[3]! + w[4]! * w[4]! + w[5]! * w[5]!, b2 = w[6]! * w[6]! + w[7]! * w[7]! + w[8]! * w[8]!;
  const E0 = Math.atan2((qx * w[6]! + qy * w[7]! + qz * w[8]!) / b2, (qx * w[3]! + qy * w[4]! + qz * w[5]!) / a2);
  // scan +-1 rad, then golden section around the best sample
  const S = 40, span = 1;
  let bi = 0, bv = Infinity;
  for (let k = 0; k <= S; k++) { const E = E0 - span + (2 * span * k) / S; const v = f(E); if (v < bv) { bv = v; bi = k; } }
  let lo = E0 - span + (2 * span * Math.max(0, bi - 1)) / S, hi = E0 - span + (2 * span * Math.min(S, bi + 1)) / S;
  const g = 0.6180339887498949;
  let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = f(x1), f2 = f(x2);
  for (let it = 0; it < 40; it++) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = f(x1); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = f(x2); }
  }
  return Math.sqrt(Math.min(f1, f2, bv));
}
