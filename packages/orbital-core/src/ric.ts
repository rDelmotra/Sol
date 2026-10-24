// ============================================================
// Radial / in-track / cross-track (RIC) frame and Mahalanobis distance for a
// diagonal covariance. Pure maths, no imports. Used to measure how far a
// predicted position is from a reference one, in axes that make sense for an
// orbit (R = away from Earth, C = along the orbit normal, I = completes the set,
// roughly along the velocity for near-circular orbits).
// ============================================================

export type V3 = [number, number, number];

export interface RicBasis {
  /** Unit vectors in the input frame. */
  r: V3;
  i: V3;
  c: V3;
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** RIC basis from position and velocity (any consistent frame). Null if r and v are parallel or zero. */
export function ricBasis(pos: V3, vel: V3): RicBasis | null {
  const hx = cross(pos, vel);
  if (!(Math.hypot(hx[0], hx[1], hx[2]) > 0) || !(Math.hypot(pos[0], pos[1], pos[2]) > 0)) return null;
  const r = unit(pos);
  const c = unit(hx);
  const i = cross(c, r);
  return { r, i, c };
}

/** Components of a vector in the RIC basis: [radial, in-track, cross-track]. */
export function toRic(d: V3, b: RicBasis): V3 {
  return [dot(d, b.r), dot(d, b.i), dot(d, b.c)];
}

/** Mahalanobis distance of a RIC offset for a diagonal covariance given as three 1-sigma values. */
export function mahalanobisDiag(d: V3, sigma: V3): number {
  const a = d[0] / sigma[0], b = d[1] / sigma[1], c = d[2] / sigma[2];
  return Math.sqrt(a * a + b * b + c * c);
}

/** P(chi-square with 3 degrees of freedom <= x2): the share of a 3D Gaussian inside Mahalanobis distance sqrt(x2). */
export function chi3Cdf(x2: number): number {
  if (!(x2 > 0)) return 0;
  return erf(Math.sqrt(x2 / 2)) - Math.sqrt((2 * x2) / Math.PI) * Math.exp(-x2 / 2);
}

/** Error function (Abramowitz-Stegun 7.1.26 is too coarse; this is a series/continued-fraction pair good to ~1e-12). */
export function erf(x: number): number {
  const ax = Math.abs(x);
  let y: number;
  if (ax < 2.5) {
    // Maclaurin series
    let term = ax, sum = ax;
    for (let n = 1; n < 100; n++) {
      term *= (-ax * ax) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17) break;
    }
    y = (2 / Math.sqrt(Math.PI)) * sum;
  } else {
    // erfc by continued fraction (Lentz-free, backward evaluation)
    let f = 0;
    for (let k = 60; k >= 1; k--) f = k / 2 / (ax + f);
    y = 1 - Math.exp(-ax * ax) / (Math.sqrt(Math.PI) * (ax + f));
  }
  return x < 0 ? -y : y;
}
