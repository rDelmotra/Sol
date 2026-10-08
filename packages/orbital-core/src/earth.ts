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
