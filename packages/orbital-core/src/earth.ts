// ============================================================
// Earth figure — THE ONE home for "how big / what shape is the Earth".
//
// The figure is WGS84 (a = 6378.137 km, 1/f = 298.257223563). ER_KM (units.ts)
// is a different thing: the scene/wire LENGTH UNIT ("1 ER" in worker buffers,
// the WASM output, DSO CanonicalStateVector, the render scene). ER_KM stays
// 6371 forever; it is NOT the Earth's radius and no longer equals it.
//
// altitudeKmFromEr / latitudeDegFromEr / geodeticLatAltFromEr are geodetic and
// are valid on TEME or ECEF vectors ONLY (they depend on rho = sqrt(x²+y²) and
// z, which are invariant under rotation about z). They are NOT valid on render
// scene (Y-up) vectors — convert with the frontend's engine/scene/frames.ts
// sceneToSource* first.
// ============================================================

import type { Vec3 } from './vec.js';
import { ER_KM, RAD, DEG } from './units.js';

// ------------------------------------------------------------
// WGS84 ellipsoid. Source: NIMA TR8350.2 / EPSG:7030 defining constants (a, 1/f).
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

/**
 * Cylindrical shadow (umbra) radius, in earth-radii (scene unit): the WGS84
 * equatorial radius a / ER_KM (1.0011202...). The eclipse test is the
 * cylindrical-umbra model using this radius.
 */
export const UMBRA_RADIUS_ER = WGS84_A_KM / ER_KM;

export interface GeodeticInput {
  latDeg: number;
  lonDeg: number;
  altKm?: number;
}

/**
 * WGS84 geodetic (lat/lon/alt above ellipsoid) → ECEF position, earth-radii
 * (scene unit, 1 ER = ER_KM). N = a/√(1 − e² sin²φ);
 * x,y = (N + h)cosφ(cosλ, sinλ); z = (N(1 − e²) + h)sinφ; all / ER_KM.
 * Output is ECEF (x toward lon 0, z toward north pole), NOT scene Y-up.
 */
export function geodeticToEcefEr(g: GeodeticInput): Vec3 {
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
 * Local "up" (outward ellipsoid surface normal) at a geodetic point, ECEF
 * frame, unit vector: (cosφ·cosλ, cosφ·sinλ, sinφ) with φ geodetic latitude.
 * This is the exact WGS84 normal. It is NOT parallel to the position vector:
 * the angle between them is φ − ψ (geodetic minus geocentric latitude, up to
 * 0.1924° at the surface).
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
export function geodeticLatAltFromEr(r: Vec3): { latDeg: number | null; altKm: number } {
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

/**
 * Altitude above the WGS84 ellipsoid, km, from a TEME or ECEF position vector
 * in earth-radii. NOT valid on scene Y-up vectors (see geodeticLatAltFromEr).
 */
export function altitudeKmFromEr(r: Vec3): number {
  return geodeticLatAltFromEr(r).altKm;
}

/**
 * WGS84 geodetic latitude, degrees, from a TEME or ECEF position vector in
 * earth-radii. Null for the zero vector. NOT valid on scene Y-up vectors.
 */
export function latitudeDegFromEr(r: Vec3): number | null {
  return geodeticLatAltFromEr(r).latDeg;
}

/**
 * Geocentric latitude, degrees, from a position vector: asin(z/|r|) · DEG.
 * Always the angle from the equatorial plane as seen from the Earth's CENTRE
 * (unlike latitudeDegFromEr, which is geodetic). Used by the analytic sweep
 * prefilter, whose geometry is purely geocentric. Rotation-about-z invariant
 * (valid on ECEF or TEME). Null for the zero vector.
 */
export function geocentricLatitudeDegFromEr(r: Vec3): number | null {
  const mag = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
  if (mag === 0) return null;
  return Math.asin(r.z / mag) * DEG;
}
