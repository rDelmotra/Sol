// ============================================================
// Illumination — sun-relative lighting: satellite eclipse (cylindrical Earth
// umbra), observer darkness (civil twilight), and apparent phase brightness.
//
// isEclipsedFromComponents / getPhaseMultiplierFromComponents are copies of
// frontend orbital/lighting.ts. The eclipse test is the CYLINDRICAL umbra
// model, with the cylinder radius UMBRA_RADIUS_ER (earth.ts) = WGS84
// equatorial radius a / ER_KM = 1.0011202... earth-radii (it was a literal
// 1.0 under the old spherical figure).
//
// isObserverInDarkFromComponents is ALSO kept verbatim — current render code
// (frontend orbital/lighting.ts) calls it directly with a raw position it
// normalizes itself. New code should prefer isObserverDarkFromUp / isObserverDark,
// which take an already-unit "up" vector (e.g. observer.ts's ObserverFrame.up)
// and skip the redundant normalize.
// ============================================================

import type { Vec3 } from './vec.js';
import { UMBRA_RADIUS_ER } from './earth.js';
import { RAD } from './units.js';

/** sin(-6°) — civil-twilight threshold: sun elevation below this = observer in darkness. */
export const CIVIL_TWILIGHT_SIN = Math.sin(-6 * RAD);

/**
 * True when a satellite at TEME position (satX,satY,satZ) (earth-radii) is in
 * Earth's cylindrical shadow, given the sun direction as a unit vector.
 * Verbatim: frontend orbital/lighting.ts isEclipsedFromComponents.
 */
export function isEclipsedFromComponents(
  satX: number,
  satY: number,
  satZ: number,
  sunX: number,
  sunY: number,
  sunZ: number,
): boolean {
  const dot = satX * sunX + satY * sunY + satZ * sunZ;
  if (dot >= 0) return false;

  const satLenSq = satX * satX + satY * satY + satZ * satZ;
  const distSq = satLenSq - (dot * dot);
  return distSq < UMBRA_RADIUS_ER * UMBRA_RADIUS_ER;
}

/**
 * True when the observer at raw position (obsX,obsY,obsZ) is in civil
 * darkness (sun elevation < -6°). Normalizes the position itself — kept
 * verbatim for the current render call sites; prefer isObserverDarkFromUp
 * when an already-unit "up" is available.
 * Verbatim: frontend orbital/lighting.ts isObserverInDarkFromComponents.
 */
export function isObserverInDarkFromComponents(
  obsX: number,
  obsY: number,
  obsZ: number,
  sunX: number,
  sunY: number,
  sunZ: number,
): boolean {
  const obsLen = Math.sqrt(obsX * obsX + obsY * obsY + obsZ * obsZ);
  if (obsLen === 0) {
    return false;
  }

  const invObsLen = 1 / obsLen;
  const sinElev = ((obsX * invObsLen) * sunX) + ((obsY * invObsLen) * sunY) + ((obsZ * invObsLen) * sunZ);
  return sinElev < CIVIL_TWILIGHT_SIN;
}

/**
 * Apparent-phase brightness multiplier (0.1..1) for a satellite seen from an
 * observer, given the sun direction as a unit vector.
 * Verbatim: frontend orbital/lighting.ts getPhaseMultiplierFromComponents.
 */
export function getPhaseMultiplierFromComponents(
  satX: number,
  satY: number,
  satZ: number,
  obsX: number,
  obsY: number,
  obsZ: number,
  sunX: number,
  sunY: number,
  sunZ: number,
): number {
  const vx = obsX - satX;
  const vy = obsY - satY;
  const vz = obsZ - satZ;
  const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (vLen === 0) {
    return 0.1;
  }

  const invVLen = 1 / vLen;
  const phaseCos = ((vx * invVLen) * sunX) + ((vy * invVLen) * sunY) + ((vz * invVLen) * sunZ);
  return Math.max(0.1, (phaseCos + 0.5) / 1.5);
}

/** Vec3-shaped wrapper over isEclipsedFromComponents. */
export function isEclipsed(r: Vec3, sun: Vec3): boolean {
  return isEclipsedFromComponents(r.x, r.y, r.z, sun.x, sun.y, sun.z);
}

/**
 * True when the observer, given as an already-unit local "up" vector (e.g.
 * observer.ts's ObserverFrame.up), is in civil darkness:
 * sin(sun elevation) = up·sun < CIVIL_TWILIGHT_SIN. Skips the normalize that
 * isObserverInDarkFromComponents performs on a raw position — prefer this
 * when the caller already has a unit "up".
 */
export function isObserverDarkFromUp(
  ux: number,
  uy: number,
  uz: number,
  sx: number,
  sy: number,
  sz: number,
): boolean {
  const sinElev = ux * sx + uy * sy + uz * sz;
  return sinElev < CIVIL_TWILIGHT_SIN;
}

/** Vec3-shaped wrapper over isObserverDarkFromUp. */
export function isObserverDark(up: Vec3, sun: Vec3): boolean {
  return isObserverDarkFromUp(up.x, up.y, up.z, sun.x, sun.y, sun.z);
}
