import * as THREE from 'three';

/**
 * The ONE home for the render-side frame conversion.
 *
 * Inertial TEME/ECI — and Earth-fixed ECEF, which shares the same right-handed,
 * Z-up-to-north handedness — map into the Three.js Y-up scene frame by the same swap:
 *
 *     scene.x =  src.x
 *     scene.y =  src.z      (source north pole → Three.js up)
 *     scene.z = -src.y
 *
 * This is purely a rendering concern: the SGP4 / DSO workers stay frame-agnostic and
 * emit raw TEME (see src/workers/sgp4.worker.ts) — the swap happens here, on the
 * render side, so there is a single place to read or change the convention.
 * See my_plans/webgl takram reference/02_COORDINATES_AND_TIME.txt.
 */

/** Swap a source-frame (TEME/ECI/ECEF) vector into a new scene-frame Vector3. */
export function sourceToScene(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

/** Swap a source-frame vector into an existing Vector3 (no allocation). Returns `out`. */
export function sourceToSceneInto(
  out: THREE.Vector3,
  x: number,
  y: number,
  z: number,
): THREE.Vector3 {
  return out.set(x, z, -y);
}

/**
 * Swap a source-frame vector into a packed Float32Array at `offset` (x,y,z layout),
 * optionally scaling every component (e.g. km → Earth radii). Default scale = 1.
 */
export function writeSourceToScene(
  out: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
  scale = 1,
): void {
  out[offset] = x * scale;
  out[offset + 1] = z * scale;
  out[offset + 2] = -y * scale;
}
