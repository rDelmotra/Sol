import { MINUTES_PER_DAY, WGS84_A_KM, semiMajorAxisKmFromMeanMotion } from '@orbitwatch/orbital-core';

// ============================================================
// Orbit summary from MEAN_MOTION and ECCENTRICITY.
//
// CelesTrak's GP JSON has no PERIOD, APOAPSIS or PERIAPSIS (Space-Track does), so
// for a CelesTrak record they are derived here. Same definition as Space-Track's:
//   period   = minutes per revolution = 1440 / MEAN_MOTION (rev/day)
//   apogee   = a * (1 + e) - Earth radius   (km ABOVE THE SURFACE, not from the centre)
//   perigee  = a * (1 - e) - Earth radius
// with a = cbrt(mu / n^2) from orbital-core (mu = 398600.4418) and the WGS84
// equatorial radius. Space-Track uses WGS72 (mu 398600.8, radius 6378.135); the
// difference is about 0.002 km, far below anything shown.
// ============================================================

export interface OrbitSummary {
  /** Minutes. */
  period: number;
  /** km above the surface. */
  apogee: number;
  /** km above the surface. */
  perigee: number;
}

/** Null when the elements do not describe a bound orbit (mean motion <= 0, e outside [0, 1)). */
export function summarizeOrbit(meanMotionRevPerDay: number, eccentricity: number): OrbitSummary | null {
  if (!Number.isFinite(meanMotionRevPerDay) || !Number.isFinite(eccentricity)) return null;
  if (eccentricity < 0 || eccentricity >= 1) return null;
  const a = semiMajorAxisKmFromMeanMotion(meanMotionRevPerDay);
  if (a === null) return null;
  return {
    period: MINUTES_PER_DAY / meanMotionRevPerDay,
    apogee: a * (1 + eccentricity) - WGS84_A_KM,
    perigee: a * (1 - eccentricity) - WGS84_A_KM,
  };
}
