// ============================================================
// Observer frame — geodetic (lat/lon/alt) → position + local "up", in ER.
//
// observerTeme(g, tMs).position is bit-identical to the pre-orbital-core
// astro.ts observerTeme / orbital/coordinates.ts getObserverScenePosition
// (pre-scene-swap) math.
// ============================================================

import type { Vec3 } from './vec.js';
import { geodeticToEcefEr, geodeticUpEcef, type GeodeticInput } from './earth.js';
import { ecefToTeme } from './rotation.js';
import { gmst } from './time.js';

export interface ObserverFrame {
  /** Position, ER. Frame (ECEF vs TEME) depends on which function built this. */
  position: Vec3;
  /** Local outward-normal unit vector, same frame as `position`. */
  up: Vec3;
}

/** Observer position + local up in the ECEF frame (no sidereal rotation applied). */
export function observerEcef(g: GeodeticInput): ObserverFrame {
  return {
    position: geodeticToEcefEr(g),
    up: geodeticUpEcef(g),
  };
}

/** Observer position + local up in the TEME frame, at UTC millisecond timestamp `tMs`. */
export function observerTeme(g: GeodeticInput, tMs: number): ObserverFrame {
  const theta = gmst(tMs);
  return {
    position: ecefToTeme(geodeticToEcefEr(g), theta),
    up: ecefToTeme(geodeticUpEcef(g), theta),
  };
}
