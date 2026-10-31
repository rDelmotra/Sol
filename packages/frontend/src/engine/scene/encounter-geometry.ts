import * as THREE from 'three';
import { ER_KM } from '@orbitwatch/orbital-core';

/**
 * Pure geometry for the encounter overlay. Positions are scene-frame vectors in
 * Earth radii, as the satellite renderer holds them. Everything here is drawing
 * support: the server owns the miss distance and Pc.
 */

/** Straight-line distance between two scene positions, km. */
export function separationKm(p: THREE.Vector3, q: THREE.Vector3): number {
  return p.distanceTo(q) * ER_KM;
}

/**
 * Direction of the other object's motion relative to the primary: the finite
 * difference of the two objects' positions between the renderer's previous and
 * current samples (about one propagation tick, ~1 s apart), as a unit vector.
 * Null when the relative motion is not measurable (identical samples).
 */
export function relativeApproachDirection(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  q0: THREE.Vector3,
  q1: THREE.Vector3,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  out.copy(q1).sub(q0).sub(p1).add(p0);
  const len = out.length();
  if (!(len > 1e-12)) return null;
  return out.multiplyScalar(1 / len);
}
