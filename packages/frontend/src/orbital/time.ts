import * as THREE from 'three';
import { sourceToScene } from './frames';

function toJulianDate(date: Date): number {
  return date.getTime() / 86400000.0 + 2440587.5;
}

/**
 * Greenwich Apparent Sidereal Time in radians.
 * IAU 1982 model. Used to rotate the Earth mesh each frame.
 */
export function getGAST(date: Date): number {
  const jd = toJulianDate(date);
  const du = jd - 2451545.0;
  const T  = du / 36525.0;
  // IAU 1982 continuous GMST formula (no 0h split needed)
  const gmstDeg = 280.46061837
    + 360.98564736629 * du
    + 0.000387933 * T * T
    - T * T * T / 38710000.0;
  return (((gmstDeg % 360) + 360) % 360) * (Math.PI / 180.0);
}

/**
 * Sun direction as a Y-up world-space unit vector (ECI frame).
 *
 * Steps: Julian date → mean anomaly → ecliptic longitude →
 * equatorial ECI → map to Three.js Y-up.
 *
 * No GAST rotation is applied here — Engine.ts already rotates the Earth
 * mesh by GAST, so the sun direction must stay in the inertial (ECI) frame.
 */
export function getSunDirection(date: Date): THREE.Vector3 {
  const jd = toJulianDate(date);
  const T = (jd - 2451545.0) / 36525.0;

  // Mean longitude and mean anomaly of the Sun (radians)
  const L0 =
    (280.46646 + 36000.76983 * T + 0.0003032 * T * T) * (Math.PI / 180.0);
  const M =
    (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * (Math.PI / 180.0);

  // Equation of center (radians)
  const C =
    ((1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) +
      (0.019993 - 0.000101 * T) * Math.sin(2 * M) +
      0.000289 * Math.sin(3 * M)) *
    (Math.PI / 180.0);

  // Sun's true ecliptic longitude
  const sunLon = L0 + C;

  // Mean obliquity of the ecliptic (radians)
  const eps =
    (23.439291111 -
      0.013004167 * T -
      0.0000001639 * T * T +
      0.0000005036 * T * T * T) *
    (Math.PI / 180.0);

  // ECI equatorial unit vector toward the Sun
  const eciX = Math.cos(sunLon);
  const eciY = Math.sin(sunLon) * Math.cos(eps);
  const eciZ = Math.sin(sunLon) * Math.sin(eps);

  // Map ECI → Three.js Y-up world space via the one shared swap (no GAST rotation —
  // Engine rotates the mesh). frames.ts owns the axis convention.
  return sourceToScene(eciX, eciY, eciZ).normalize();
}
