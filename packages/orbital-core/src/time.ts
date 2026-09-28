// ============================================================
// Time — Julian date + Greenwich Mean Sidereal Time.
//
// gmst() is bit-identical to the pre-orbital-core "getGAST" math (frontend
// orbital/time.ts, orbital/coordinates.ts's private copy, backend
// analytic/astro.ts): same operation order, same constants, same modulo
// normalisation. The old name "getGAST" (Greenwich APPARENT Sidereal Time)
// was a misnomer — this is the IAU-82 GMST (MEAN sidereal time) formula.
// There is no equation-of-the-equinoxes correction here, so it does not
// actually compute apparent sidereal time; the name is corrected here.
// ============================================================

import { RAD } from './units.js';

/** Julian date of the J2000.0 epoch (2000-01-01T12:00:00 UTC). */
export const JD_J2000 = 2451545.0;

/** Julian date from a UTC millisecond timestamp. */
export function julianDate(tMs: number): number {
  return tMs / 86400000.0 + 2440587.5;
}

/**
 * Greenwich Mean Sidereal Time, in radians, normalised to [0, 2π).
 *
 * IAU-82 GMST formula (continuous form, no 0h split needed).
 */
export function gmst(tMs: number): number {
  const jd = julianDate(tMs);
  const du = jd - JD_J2000;
  const T = du / 36525.0;
  const gmstDeg = 280.46061837
    + 360.98564736629 * du
    + 0.000387933 * T * T
    - T * T * T / 38710000.0;
  return (((gmstDeg % 360) + 360) % 360) * RAD;
}
