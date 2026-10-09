// ============================================================
// Sun direction — equatorial (TEME-treated) frame.
//
// Bit-identical to the pre-orbital-core sunDirTeme/getSunDirection math
// (the former backend and frontend copies, now removed): same operation
// order, same constants. No GMST rotation is applied — this is the
// inertial-of-date direction (frames that need the Earth-fixed direction
// rotate it themselves via rotation.ts).
// ============================================================

import type { Vec3 } from './vec.js';
import { julianDate, JD_J2000 } from './time.js';
import { RAD } from './units.js';

/** Sun direction as a unit vector in the equatorial (TEME-treated) frame at UTC ms `tMs`. */
export function sunDirection(tMs: number): Vec3 {
  const jd = julianDate(tMs);
  const T = (jd - JD_J2000) / 36525.0;

  // Mean longitude and mean anomaly of the Sun (radians)
  const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) * RAD;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * RAD;

  // Equation of center (radians)
  const C = ((1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
    + 0.000289 * Math.sin(3 * M)) * RAD;

  // Sun's true ecliptic longitude
  const sunLon = L0 + C;

  // Mean obliquity of the ecliptic (radians)
  const eps = (23.439291111
    - 0.013004167 * T
    - 0.0000001639 * T * T
    + 0.0000005036 * T * T * T) * RAD;

  // Equatorial unit vector toward the Sun
  return {
    x: Math.cos(sunLon),
    y: Math.sin(sunLon) * Math.cos(eps),
    z: Math.sin(sunLon) * Math.sin(eps),
  };
}
