// ============================================================
// Collision probability for a short, fast encounter (2D Foster method), plus the geometry
// that gets a 3D position covariance into the encounter plane. Pure maths, imports only ./ric.js.
//
// Model: during the encounter the two objects fly straight past each other at constant relative
// velocity (valid when the encounter lasts seconds). Their position errors are Gaussian, independent,
// and constant over that time. Project the combined covariance onto the plane perpendicular to the
// relative velocity ("encounter plane"). The objects collide if the relative position in that plane
// falls inside a disc of radius R (sum of the two hard-body radii) around the origin. So
//     Pc = integral over the disc of the 2D Gaussian centred on the miss vector m with covariance C.
// ============================================================
import { erf, type RicBasis, type V3 } from './ric.js';

/** Symmetric 3x3 matrix [xx, xy, xz, yy, yz, zz]. */
export type Sym3 = [number, number, number, number, number, number];
/** Symmetric 2x2 matrix. */
export interface Cov2 { xx: number; xy: number; yy: number }

const SQRT2 = Math.SQRT2;

/** Complementary error function, accurate in the far tail (continued fraction beyond 2.5). */
export function erfc(x: number): number {
  if (x < 2.5) return 1 - erf(x);
  let f = 0;
  for (let k = 60; k >= 1; k--) f = k / 2 / (x + f);
  return Math.exp(-x * x) / (Math.sqrt(Math.PI) * (x + f));
}

/** Standard normal upper tail Q(z) = P(Z > z). */
const Q = (z: number): number => 0.5 * erfc(z / SQRT2);

/** P(lo < Z < hi) for a standard normal, without cancellation in the tails. */
export function phiBetween(lo: number, hi: number): number {
  if (hi <= lo) return 0;
  if (lo >= 0) return Math.max(0, Q(lo) - Q(hi));
  if (hi <= 0) return Math.max(0, Q(-hi) - Q(-lo));
  return 1 - Q(hi) - Q(-lo);
}

// ---- Gauss-Kronrod 7/15 ----
const XGK = [0.991455371120812639206854697526329, 0.949107912342758524526189684047851, 0.864864423359769072789712788640926, 0.741531185599394439863864773280788, 0.58608723546769113029414483825873, 0.405845151377397166906606412076961, 0.207784955007898467600689403773245, 0];
const WGK = [0.02293532201052922496373200805897, 0.063092092629978553290700663189204, 0.104790010322250183839876322541518, 0.140653259715525918745189590510238, 0.16900472663926790282658342659855, 0.190350578064785409913256402421014, 0.204432940075298892414161999234649, 0.209482141084727828012999174891714];
const WG = [0.129484966168869693270611432679082, 0.27970539148927666790146777142378, 0.381830050505118944950369775488975, 0.417959183673469387755102040816327];

function gk15(f: (x: number) => number, a: number, b: number): { k: number; err: number } {
  const c = 0.5 * (a + b), h = 0.5 * (b - a);
  const fc = f(c);
  let rk = fc * WGK[7]!, rg = fc * WG[3]!;
  for (let j = 0; j < 7; j++) {
    const dx = h * XGK[j]!;
    const s = f(c - dx) + f(c + dx);
    rk += WGK[j]! * s;
    if (j % 2 === 1) rg += WG[(j - 1) / 2]! * s;
  }
  return { k: rk * h, err: Math.abs((rk - rg) * h) };
}

function adaptive(f: (x: number) => number, a: number, b: number, relTol: number, absTol: number, depth: number): number {
  const { k, err } = gk15(f, a, b);
  if (depth <= 0 || err <= Math.max(absTol, relTol * Math.abs(k))) return k;
  const m = 0.5 * (a + b);
  return adaptive(f, a, m, relTol, absTol, depth - 1) + adaptive(f, m, b, relTol, absTol, depth - 1);
}

/** Principal axes of a 2x2 covariance: 1-sigma along each axis and the rotation angle of the first axis. */
export function principalAxes(c: Cov2): { s1: number; s2: number; theta: number } {
  const mean = 0.5 * (c.xx + c.yy);
  const dev = Math.hypot(0.5 * (c.xx - c.yy), c.xy);
  const l1 = mean + dev, l2 = Math.max(mean - dev, 1e-24 * Math.max(l1, 1e-300));
  return { s1: Math.sqrt(l1), s2: Math.sqrt(l2), theta: 0.5 * Math.atan2(2 * c.xy, c.xx - c.yy) };
}

/**
 * Probability that a 2D Gaussian (mean = miss vector (mx, my) in km, covariance `cov` in km^2) lies inside a disc of radius
 * `radius` km around the origin. Integrates exactly along one principal axis (the other axis in closed form with erf),
 * adaptive Gauss-Kronrod on x = R sin t. Relative accuracy about 1e-8 for any ratio of R to sigma.
 */
export function pcFoster(mx: number, my: number, cov: Cov2, radius: number): number {
  if (!(radius > 0)) return 0;
  const { s1, s2, theta } = principalAxes(cov);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const m1 = mx * ct + my * st, m2 = -mx * st + my * ct;
  const R = radius;
  const norm = 1 / (s1 * Math.sqrt(2 * Math.PI));
  const f = (t: number): number => {
    const x = R * Math.sin(t), h = R * Math.cos(t);
    const z = (x - m1) / s1;
    const g = norm * Math.exp(-0.5 * z * z);
    if (g === 0) return 0;
    return g * phiBetween((-h - m2) / s2, (h - m2) / s2) * h;
  };
  // break points: even panels plus the neighbourhood of the Gaussian peak along x (so a narrow peak cannot be missed)
  const pts = new Set<number>();
  for (let k = 0; k <= 8; k++) pts.add(-Math.PI / 2 + (k * Math.PI) / 8);
  for (const xs of [m1 - 4 * s1, m1 - 2 * s1, m1 - s1, m1, m1 + s1, m1 + 2 * s1, m1 + 4 * s1]) {
    if (Math.abs(xs) < R) pts.add(Math.asin(xs / R));
  }
  const b = [...pts].sort((p, q) => p - q);
  let sum = 0;
  for (let i = 0; i + 1 < b.length; i++) if (b[i + 1]! - b[i]! > 1e-15) sum += adaptive(f, b[i]!, b[i + 1]!, 1e-9, 1e-300, 14);
  return Math.min(1, Math.max(0, sum));
}

/** Zero-miss, circular covariance (sigma in both axes): Pc = 1 - exp(-R^2 / (2 sigma^2)). */
export const pcZeroMissCircular = (radius: number, sigma: number): number => 1 - Math.exp(-(radius * radius) / (2 * sigma * sigma));

/**
 * Maximum Pc over a uniform scaling of the covariance (C -> k C), the usual worst-case bound when the covariance size is doubtful.
 * Small-disc limit: Pc(k) ~ (R^2 / 2 s1 s2 k) exp(-q / 2k) with q = m1^2/s1^2 + m2^2/s2^2, maximal at k = q/2.
 * That start is refined by golden section on the exact integral. A miss inside the disc gives 1 (k -> 0).
 */
export function pcMax(mx: number, my: number, cov: Cov2, radius: number): { pc: number; scale: number } {
  const d = Math.hypot(mx, my);
  if (d <= radius) return { pc: 1, scale: 0 };
  const { s1, s2, theta } = principalAxes(cov);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const m1 = mx * ct + my * st, m2 = -mx * st + my * ct;
  const q = (m1 * m1) / (s1 * s1) + (m2 * m2) / (s2 * s2);
  const k0 = Math.max(q / 2, 1e-12);
  const at = (lk: number): number => {
    const k = Math.exp(lk);
    return pcFoster(mx, my, { xx: cov.xx * k, xy: cov.xy * k, yy: cov.yy * k }, radius);
  };
  // the function is unimodal in ln k; bracket generously, shrink by golden section
  let lo = Math.log(k0) - Math.log(8), hi = Math.log(k0) + Math.log(8);
  const GR = 0.6180339887498949;
  let x1 = hi - GR * (hi - lo), x2 = lo + GR * (hi - lo), f1 = at(x1), f2 = at(x2);
  for (let it = 0; it < 22; it++) {
    if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + GR * (hi - lo); f2 = at(x2); }
    else { hi = x2; x2 = x1; f2 = f1; x1 = hi - GR * (hi - lo); f1 = at(x1); }
  }
  const best = f1 > f2 ? { pc: f1, lk: x1 } : { pc: f2, lk: x2 };
  return { pc: best.pc, scale: Math.exp(best.lk) };
}

// ---------------- geometry ----------------
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: V3): V3 => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };

/** Covariance matrix in the input frame of a diagonal RIC covariance (1-sigma per axis, km). */
export function covFromRic(b: RicBasis, sigma: V3): Sym3 {
  const out: Sym3 = [0, 0, 0, 0, 0, 0];
  const axes: V3[] = [b.r, b.i, b.c];
  for (let a = 0; a < 3; a++) {
    const u = axes[a]!, v = sigma[a]! * sigma[a]!;
    out[0] += v * u[0] * u[0]; out[1] += v * u[0] * u[1]; out[2] += v * u[0] * u[2];
    out[3] += v * u[1] * u[1]; out[4] += v * u[1] * u[2]; out[5] += v * u[2] * u[2];
  }
  return out;
}
export const addSym3 = (a: Sym3, b: Sym3): Sym3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5]];

export interface EncounterGeometry {
  /** Miss vector components in the encounter plane (km); axis 1 lies along the miss direction, so my is 0 unless the miss is zero. */
  mx: number;
  my: number;
  /** Combined covariance in the same plane axes (km^2). */
  cov: Cov2;
  /** Relative speed (km/s). */
  vrel: number;
  /** Miss distance in 3D (km). */
  miss: number;
  /** Component of the 3D miss vector along the relative velocity (km); ~0 when evaluated at the time of closest approach. */
  along: number;
}

/**
 * Encounter plane from the relative position (secondary - primary) and relative velocity at the time of closest approach,
 * and the 3D combined covariance (same frame). Axes: e1 = direction of the miss component perpendicular to the velocity,
 * e2 = w x e1 with w the unit relative velocity. Returns null if the relative speed is zero.
 */
export function encounterGeometry(relPos: V3, relVel: V3, cov: Sym3): EncounterGeometry | null {
  const vrel = Math.hypot(relVel[0], relVel[1], relVel[2]);
  if (!(vrel > 0)) return null;
  const w = unit3(relVel);
  const along = dot3(relPos, w);
  const perp: V3 = [relPos[0] - along * w[0], relPos[1] - along * w[1], relPos[2] - along * w[2]];
  const pn = Math.hypot(perp[0], perp[1], perp[2]);
  let e1: V3;
  if (pn > 1e-12) e1 = [perp[0] / pn, perp[1] / pn, perp[2] / pn];
  else {
    const t: V3 = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    e1 = unit3(cross3(w, t));
  }
  const e2 = cross3(w, e1);
  const mul = (u: V3): V3 => [
    cov[0] * u[0] + cov[1] * u[1] + cov[2] * u[2],
    cov[1] * u[0] + cov[3] * u[1] + cov[4] * u[2],
    cov[2] * u[0] + cov[4] * u[1] + cov[5] * u[2],
  ];
  const c1 = mul(e1), c2 = mul(e2);
  return {
    mx: pn, my: 0,
    cov: { xx: dot3(e1, c1), xy: dot3(e1, c2), yy: dot3(e2, c2) },
    vrel, miss: Math.hypot(relPos[0], relPos[1], relPos[2]), along,
  };
}
