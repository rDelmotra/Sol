// ============================================================
// Earth figure — THE ONE home for "how big / what shape is the Earth".
// Phase 3 (WGS84 migration) edits ONLY this file.
//
// EARTH_RADIUS_KM is the PHYSICAL figure (spherical today). ER_KM (units.ts)
// is the scene/wire LENGTH UNIT — "1 ER" in worker buffers, the WASM output,
// DSO CanonicalStateVector and the render scene. They are separate constants
// that happen to share the value 6371 today: ER_KM stays 6371 forever (it's
// a unit), while EARTH_RADIUS_KM becomes a WGS84 ellipsoid in phase 3.
// Keeping two names now means phase 3 only has to touch this file.
// ============================================================

import type { Vec3 } from './vec.js';
import { ER_KM, RAD, DEG } from './units.js';

/** Physical Earth radius, km (spherical figure — see header re: ER_KM vs this). */
export const EARTH_RADIUS_KM = 6371;

/** Cylindrical shadow (umbra) radius, in earth-radii (scene unit). */
export const UMBRA_RADIUS_ER = EARTH_RADIUS_KM / ER_KM;

// ------------------------------------------------------------
// WGS84 ellipsoid (S4a: added, NOT yet used by the functions above).
// Source: NIMA TR8350.2 / EPSG:7030 defining constants (a, 1/f).
// ------------------------------------------------------------

/** WGS84 semi-major (equatorial) axis a, km. Defining constant. */
export const WGS84_A_KM = 6378.137;

/** WGS84 inverse flattening 1/f, dimensionless. Defining constant. */
export const WGS84_INV_F = 298.257223563;

/** WGS84 flattening f = 1/(1/f), dimensionless. */
export const WGS84_F = 1 / WGS84_INV_F;

/** WGS84 semi-minor (polar) axis b = a(1 - f), km (6356.752314245...). */
export const WGS84_B_KM = WGS84_A_KM * (1 - WGS84_F);

/** WGS84 first eccentricity squared e² = f(2 - f), dimensionless (0.0066943799901413165). */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/** Second eccentricity squared e′² = e²/(1 - e²), dimensionless. Internal. */
const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2);

export interface GeodeticInput {
  latDeg: number;
  lonDeg: number;
  altKm?: number;
}

/**
 * Geodetic (lat/lon/alt) → ECEF position, in earth-radii (scene unit).
 * Spherical Earth model — same math as astro.ts observerTeme's pre-rotation
 * x/y/z: r = (EARTH_RADIUS_KM + alt) / ER_KM.
 */
export function geodeticToEcefEr(g: GeodeticInput): Vec3 {
  const lat = g.latDeg * RAD;
  const lon = g.lonDeg * RAD;
  const r = (EARTH_RADIUS_KM + (g.altKm ?? 0)) / ER_KM;

  return {
    x: r * Math.cos(lat) * Math.cos(lon),
    y: r * Math.cos(lat) * Math.sin(lon),
    z: r * Math.sin(lat),
  };
}

/**
 * Local "up" (outward surface normal) at a geodetic point, ECEF frame, unit
 * vector: (cosφ·cosλ, cosφ·sinλ, sinφ). For a spherical Earth this is exactly
 * the normalized position; it is also the correct WGS84 normal when φ is
 * geodetic latitude, which is why phase 3 (ellipsoid figure) does not need
 * to change this function's shape, only geodeticToEcefEr's.
 */
export function geodeticUpEcef(g: GeodeticInput): Vec3 {
  const lat = g.latDeg * RAD;
  const lon = g.lonDeg * RAD;
  return {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.cos(lat) * Math.sin(lon),
    z: Math.sin(lat),
  };
}

/**
 * Altitude, km, from a position vector in earth-radii.
 *
 * The current call sites (live-source.ts:245, providers/sgp4.ts:206) compute
 * this as `(|r| − 1) * EARTH_RADIUS_KM`, relying on the fact that ER_KM and
 * EARTH_RADIUS_KM are both 6371 today (so "1.0" implicitly means
 * EARTH_RADIUS_KM/ER_KM). Written explicitly here as
 * `(|r| − EARTH_RADIUS_KM/ER_KM) * ER_KM` so the two constants are spelled
 * out and stay numerically equivalent even after phase 3 changes
 * EARTH_RADIUS_KM. With today's values the two forms are bit-identical
 * (6371/6371 == 1.0 exactly in double precision).
 */
export function altitudeKmFromEr(r: Vec3): number {
  const mag = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
  return (mag - EARTH_RADIUS_KM / ER_KM) * ER_KM;
}

/**
 * Geocentric latitude, degrees, from a position vector: asin(z/|r|) · DEG.
 * This is invariant under rotation about the z-axis, so it is valid on
 * either an ECEF or a TEME position — the two frames differ only by a
 * z-axis (sidereal) rotation, which never changes z or |r|.
 * Returns null for the zero vector (undefined direction).
 */
export function latitudeDegFromEr(r: Vec3): number | null {
  const mag = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
  if (mag === 0) return null;
  return Math.asin(r.z / mag) * DEG;
}

/**
 * Geocentric latitude, degrees, from a position vector: asin(z/|r|) · DEG.
 * Always the angle from the equatorial plane as seen from the Earth's CENTRE,
 * regardless of the Earth figure (unlike latitudeDegFromEr, which becomes
 * geodetic when the figure becomes an ellipsoid). Used by the analytic sweep
 * prefilter, whose geometry is purely geocentric. Rotation-about-z invariant
 * (valid on ECEF or TEME). Null for the zero vector.
 */
export function geocentricLatitudeDegFromEr(r: Vec3): number | null {
  const mag = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
  if (mag === 0) return null;
  return Math.asin(r.z / mag) * DEG;
}

/**
 * WGS84 geodetic (lat/lon/alt above ellipsoid) → ECEF position, earth-radii
 * (scene unit, 1 ER = ER_KM). N = a/√(1 − e² sin²φ);
 * x,y = (N + h)cosφ(cosλ, sinλ); z = (N(1 − e²) + h)sinφ; all / ER_KM.
 * Output is ECEF (x toward lon 0, z toward north pole), NOT scene Y-up.
 */
export function wgs84GeodeticToEcefEr(g: GeodeticInput): Vec3 {
  const lat = g.latDeg * RAD;
  const lon = g.lonDeg * RAD;
  const h = g.altKm ?? 0;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const rhoKm = (n + h) * cosLat;
  return {
    x: (rhoKm * Math.cos(lon)) / ER_KM,
    y: (rhoKm * Math.sin(lon)) / ER_KM,
    z: ((n * (1 - WGS84_E2) + h) * sinLat) / ER_KM,
  };
}

/**
 * WGS84 geodetic latitude (deg) and ellipsoidal height (km) from a position
 * vector in earth-radii. Bowring's method, two iterations, then a pole-safe
 * height h = ρcosφ + z sinφ − a√(1 − e² sin²φ) (no 1/cosφ).
 *
 * Valid for TEME or ECEF vectors: depends only on ρ = √(x²+y²) and z, so it
 * is invariant under rotation about z. NOT valid for scene Y-up vectors —
 * convert with the frontend's engine/scene/frames.ts sceneToSource first.
 * Points deep inside the evolute (|r| ≲ 43 km) are meaningless.
 *
 * Target accuracy: latitude < 1e-9°, height < 1 mm for φ ∈ [-90°, 90°],
 * h ∈ [-50 km, 384400 km]. Origin → { latDeg: null, altKm: −WGS84_A_KM }.
 */
export function wgs84LatAltFromEr(r: Vec3): { latDeg: number | null; altKm: number } {
  const xKm = r.x * ER_KM;
  const yKm = r.y * ER_KM;
  const zKm = r.z * ER_KM;
  const rho = Math.sqrt(xKm * xKm + yKm * yKm);
  if (rho === 0 && zKm === 0) return { latDeg: null, altKm: -WGS84_A_KM };

  let beta = Math.atan2(WGS84_A_KM * zKm, WGS84_B_KM * rho);
  let phi = 0;
  for (let i = 0; i < 2; i++) {
    const sinB = Math.sin(beta);
    const cosB = Math.cos(beta);
    phi = Math.atan2(
      zKm + WGS84_EP2 * WGS84_B_KM * sinB * sinB * sinB,
      rho - WGS84_E2 * WGS84_A_KM * cosB * cosB * cosB,
    );
    beta = Math.atan2((1 - WGS84_F) * Math.sin(phi), Math.cos(phi));
  }
  const sinPhi = Math.sin(phi);
  const altKm =
    rho * Math.cos(phi) + zKm * sinPhi - WGS84_A_KM * Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  return { latDeg: phi * DEG, altKm };
}
