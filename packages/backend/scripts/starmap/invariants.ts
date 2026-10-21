// ============================================================
// SPIKE — not production.
//
// "Orbit invariants": the slowly-changing shape of an orbit, from OMM mean elements.
// An orbit is treated as a fixed wire (an ellipse) that only rotates slowly because of J2:
// the node (Omega) and the perigee direction (omega) drift, a/e/i do not.
// This is the input of the classic filter-and-refine sieves (apogee/perigee overlap,
// orbit-path distance / MOID). Frame: TEME km, like SGP4.
// ============================================================

export const MU = 398600.4418; // km^3/s^2
export const J2 = 1.08262668e-3;
export const RE = 6378.137; // km
const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

export interface Elements {
  norad: number;
  /** Semi-major axis (km) from the mean motion: a = (mu / n^2)^(1/3). */
  a: number;
  e: number;
  /** Radians. */
  i: number;
  raan: number;
  argp: number;
  /** Mean anomaly at epoch (rad). */
  m0: number;
  /** Mean motion (rad/s). */
  n: number;
  epochMs: number;
  /** Mean perigee / apogee radius (km, geocentric). */
  rp: number;
  ra: number;
  /** Secular J2 rates (rad/s). */
  raanDot: number;
  argpDot: number;
}

/** Elements from an OMM record; null if unusable. */
export function elementsFromOmm(norad: number, omm: Record<string, unknown>): Elements | null {
  const mm = Number(omm.MEAN_MOTION);
  const e = Number(omm.ECCENTRICITY);
  const inc = Number(omm.INCLINATION) * DEG;
  const raan = Number(omm.RA_OF_ASC_NODE) * DEG;
  const argp = Number(omm.ARG_OF_PERICENTER) * DEG;
  const m0 = Number(omm.MEAN_ANOMALY) * DEG;
  const epochMs = Date.parse(String(omm.EPOCH).endsWith('Z') ? String(omm.EPOCH) : String(omm.EPOCH) + 'Z');
  if (![mm, e, inc, raan, argp, m0, epochMs].every(Number.isFinite) || mm <= 0 || e < 0 || e >= 1) return null;
  const n = (mm * TWO_PI) / 86400;
  const a = Math.cbrt(MU / (n * n));
  const p = a * (1 - e * e);
  const k = 1.5 * n * J2 * (RE / p) ** 2;
  const s2 = Math.sin(inc) ** 2;
  return {
    norad, a, e, i: inc, raan, argp, m0, n, epochMs,
    rp: a * (1 - e), ra: a * (1 + e),
    raanDot: -k * Math.cos(inc),
    argpDot: k * (2 - 2.5 * s2),
  };
}

/** Node and argument of perigee at time tMs (secular drift from the element epoch). */
export function driftedAngles(el: Elements, tMs: number): { raan: number; argp: number } {
  const dt = (tMs - el.epochMs) / 1000;
  return { raan: el.raan + el.raanDot * dt, argp: el.argp + el.argpDot * dt };
}

/** Perifocal basis P (towards perigee) and Q in TEME, at time tMs. */
export function basis(el: Elements, tMs: number): { P: [number, number, number]; Q: [number, number, number] } {
  const { raan, argp } = driftedAngles(el, tMs);
  const cO = Math.cos(raan), sO = Math.sin(raan), cw = Math.cos(argp), sw = Math.sin(argp);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  return {
    P: [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si],
    Q: [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si],
  };
}

/** Point of the fixed ellipse (TEME km) at true anomaly nu (rad), with the J2 drift applied up to tMs. */
export function orbitPoint(el: Elements, nu: number, tMs: number): { x: number; y: number; z: number } {
  const { P, Q } = basis(el, tMs);
  const r = (el.a * (1 - el.e * el.e)) / (1 + el.e * Math.cos(nu));
  const u = r * Math.cos(nu), v = r * Math.sin(nu);
  return { x: u * P[0] + v * Q[0], y: u * P[1] + v * Q[1], z: u * P[2] + v * Q[2] };
}

/** Largest shift of any point of the wire caused by drifting `dtSec` seconds (km, upper bound). */
export function driftBoundKm(el: Elements, dtSec: number): number {
  return el.ra * (Math.abs(el.raanDot) + Math.abs(el.argpDot)) * dtSec;
}

/** Two element sets are identical (same epoch + same numbers): they sit on top of each other. */
export function sameElementSet(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const k of ['EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR']) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
