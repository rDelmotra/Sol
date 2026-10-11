// ============================================================
// Elements — derived quantities from an object's mean orbital elements
// (distinct from live-plane.ts, which derives from a propagated state
// vector): semi-major axis via Kepler's third law, and the two-body orbit
// shape used by orbit diagrams.
// ============================================================

import { MU_KM3_S2, RAD } from './units.js';

/**
 * Semi-major axis, km, from mean motion (revolutions/day): a = cbrt(mu / n²)
 * with n in rad/s. Returns null for a missing or non-positive mean motion —
 * same null rule as frontend query/analytic/live-source.ts and backend
 * analytic/providers/catalog.ts.
 */
export function semiMajorAxisKmFromMeanMotion(meanMotionRevPerDay: number | null): number | null {
  if (!meanMotionRevPerDay || meanMotionRevPerDay <= 0) return null;
  const radPerSec = (meanMotionRevPerDay * 2 * Math.PI) / 86400;
  return Math.cbrt(MU_KM3_S2 / (radPerSec * radPerSec));
}

// ------------------------------------------------------------
// Orbit shape for diagrams.
//
// TWO-BODY ONLY. This is plain Kepler motion around a point mass: no J2 (the
// Earth's equatorial bulge), no drag, no SGP4 mean-element theory. It is
// exact for the SHAPE of the orbit (size, eccentricity, orientation), which
// is all a diagram needs. Position along the orbit drifts away from the real
// object as time moves from epoch (minutes of along-track error per day in
// LEO). So: draw the ellipse from these functions, but place the live object
// marker from the SGP4 state, never from orbitPosition.
//
// The orbital-plane ("perifocal") frame used here: Earth at the origin,
// perigee on +x, motion counter-clockwise. Lengths are km from the Earth's
// centre. Compare against ER_KM (units.ts) to draw an Earth disc to scale.
// ------------------------------------------------------------

/**
 * The mean elements a diagram needs, as plain numbers. Angles in degrees,
 * epoch as UTC epoch milliseconds. Parsing a source record (OMM fields,
 * zoneless EPOCH strings) is the caller's job, not this package's.
 */
export interface OrbitElements {
  meanMotionRevPerDay: number;
  eccentricity: number;
  /** Mean anomaly at epoch, degrees. */
  meanAnomalyDeg: number;
  inclinationDeg: number;
  /** Right ascension of the ascending node: where the orbit crosses the equator going north. */
  raanDeg: number;
  /** Argument of perigee: where the lowest point sits, measured along the orbit from the node. */
  argPerigeeDeg: number;
  epochMs: number;
}

export interface OrbitShape {
  /** Semi-major axis, km from the Earth's centre. */
  a: number;
  e: number;
  /** Perigee and apogee RADIUS from the Earth's centre, km (not altitude). */
  rp: number;
  ra: number;
}

const finite = (n: number) => Number.isFinite(n);

/** Size and shape of the orbit. Null when the elements do not describe a bound ellipse. */
export function orbitShape(
  el: Pick<OrbitElements, 'meanMotionRevPerDay' | 'eccentricity'>,
): OrbitShape | null {
  const e = el.eccentricity;
  if (!finite(el.meanMotionRevPerDay) || !finite(e) || e < 0 || e >= 1) return null;
  const a = semiMajorAxisKmFromMeanMotion(el.meanMotionRevPerDay);
  if (a === null) return null;
  return { a, e, rp: a * (1 - e), ra: a * (1 + e) };
}

/** Kepler's equation M = E − e·sin E, solved for E (radians) by Newton's method. */
export function eccentricAnomaly(M: number, e: number): number {
  const m = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let E = e < 0.8 ? m : Math.PI;
  for (let i = 0; i < 30; i++) {
    const d = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/**
 * Two-body position in the orbital plane (km) and true anomaly (radians) at
 * `atMs`, or null if the elements are unusable. For the diagram only — the
 * live object marker comes from the SGP4 state (see the section note above).
 */
export function orbitPosition(
  el: OrbitElements,
  atMs: number,
): { x: number; y: number; r: number; trueAnomaly: number } | null {
  const shape = orbitShape(el);
  const M0 = el.meanAnomalyDeg * RAD;
  if (!shape || !finite(M0) || !finite(el.epochMs) || !finite(atMs)) return null;
  const n = (el.meanMotionRevPerDay * 2 * Math.PI) / 86400;
  const M = M0 + n * ((atMs - el.epochMs) / 1000);
  const E = eccentricAnomaly(M, shape.e);
  const trueAnomaly = 2 * Math.atan2(
    Math.sqrt(1 + shape.e) * Math.sin(E / 2),
    Math.sqrt(1 - shape.e) * Math.cos(E / 2),
  );
  const r = shape.a * (1 - shape.e * Math.cos(E));
  return { x: r * Math.cos(trueAnomaly), y: r * Math.sin(trueAnomaly), r, trueAnomaly };
}

/**
 * A point of the orbit in Earth-centred inertial axes (x toward the vernal
 * equinox, z toward the north pole), for a radius (km) and true anomaly
 * (radians). Standard rotation Rz(RAAN)·Rx(incl)·Rz(argPerigee) of the
 * perifocal point. Null when an angle is not finite.
 */
export function orbitPoint3D(
  el: Pick<OrbitElements, 'raanDeg' | 'argPerigeeDeg' | 'inclinationDeg'>,
  r: number,
  trueAnomaly: number,
): { x: number; y: number; z: number } | null {
  const O = el.raanDeg * RAD;
  const w = el.argPerigeeDeg * RAD;
  const i = el.inclinationDeg * RAD;
  if (!finite(O) || !finite(w) || !finite(i)) return null;
  const u = w + trueAnomaly;
  return {
    x: r * (Math.cos(O) * Math.cos(u) - Math.sin(O) * Math.sin(u) * Math.cos(i)),
    y: r * (Math.sin(O) * Math.cos(u) + Math.cos(O) * Math.sin(u) * Math.cos(i)),
    z: r * Math.sin(u) * Math.sin(i),
  };
}
