import * as THREE from 'three';
import { sunDirection, observerTeme, observerEcef } from '@orbitwatch/orbital-core';
import { sourceToScene } from './frames';

/**
 * The ONE place three.js meets orbital-core physics for the observer/sun.
 *
 * orbital-core (`packages/orbital-core/src`) does all the physics in plain
 * `{x,y,z}` vectors, TEME/ECEF frame, earth-radii units — no three.js, so it
 * loads in a Web Worker, Node, or the browser main thread alike. This file is
 * the render-side adapter: it calls the pure functions, then runs the result
 * through `frames.ts`'s `sourceToScene` swap to land in the Three.js Y-up
 * scene frame the renderers/layers/controllers consume.
 */

/**
 * Sun direction as a Y-up scene-space unit vector (TEME/ECI frame).
 *
 * Bit-identical to the deleted pre-orbital-core frontend `getSunDirection`:
 * same `sunDirection` math (now in orbital-core), same swap, same trailing
 * `.normalize()` (a defensive no-op — `sunDirection` already returns a unit
 * vector by construction).
 */
export function getSunDirection(date: Date): THREE.Vector3 {
  const s = sunDirection(date.getTime());
  return sourceToScene(s.x, s.y, s.z).normalize();
}

/**
 * Observer position + local "up", in the TEME (inertial-of-date) frame,
 * mapped to the Three.js Y-up scene frame. Re-anchored every frame as the
 * Earth rotates under a fixed geodetic point (visual/dome observer-sky rig,
 * dome sky/starfield horizon clip).
 *
 * `position` is bit-identical to the pre-orbital-core `getObserverScenePosition`.
 * `up` comes from orbital-core's `geodeticUpEcef` (a direct cos/sin formula)
 * rather than `position.clone().normalize()` — mathematically the same
 * direction, differing only at the ~1e-15 floating-point level (see
 * PROJECT_MAP/15_ORBITAL_CORE_AND_CONTRACTS.md §6.5).
 */
export function getObserverSceneAnchor(
  latDeg: number,
  lonDeg: number,
  altKm: number,
  date: Date,
): { position: THREE.Vector3; up: THREE.Vector3 } {
  const anchor = observerTeme({ latDeg, lonDeg, altKm }, date.getTime());
  return {
    position: sourceToScene(anchor.position.x, anchor.position.y, anchor.position.z),
    up: sourceToScene(anchor.up.x, anchor.up.y, anchor.up.z),
  };
}

/**
 * Observer position + local "up", Earth-fixed (ECEF, no sidereal rotation),
 * mapped to the Three.js Y-up scene frame — for markers parented to the
 * rotating Earth group, which already carries the GAST rotation. Replaces
 * `getObserverECEFPosition` (which returned only a position, requiring
 * callers to derive "up" themselves via `.clone().normalize()`).
 *
 * `surfaceOffsetEr` lifts the returned position off the exact surface along
 * `up` (default 0.006 ER, matching the old function's default); pass `0` for
 * markers that want to sit exactly on the surface (e.g. the horizon compass).
 */
export function getObserverEarthAnchor(
  latDeg: number,
  lonDeg: number,
  altKm = 0,
  surfaceOffsetEr = 0.006,
): { position: THREE.Vector3; up: THREE.Vector3 } {
  const ecef = observerEcef({ latDeg, lonDeg, altKm });
  const up = sourceToScene(ecef.up.x, ecef.up.y, ecef.up.z);
  const position = sourceToScene(ecef.position.x, ecef.position.y, ecef.position.z)
    .addScaledVector(up, surfaceOffsetEr);
  return { position, up };
}
