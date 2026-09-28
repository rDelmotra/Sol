// ============================================================
// Elements — derived quantities from an object's mean orbital elements
// (distinct from live-plane.ts, which derives from a propagated state
// vector). Today: semi-major axis via Kepler's third law.
// ============================================================

import { MU_KM3_S2 } from './units.js';

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
