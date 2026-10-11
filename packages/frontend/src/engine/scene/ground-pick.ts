import {
  ER_KM,
  DEG,
  WGS84_A_KM,
  WGS84_B_KM,
  geodeticLatAltFromEr,
} from '@orbitwatch/orbital-core';
import { sceneToSource } from './frames';

type V3 = { x: number; y: number; z: number };

const A_ER = WGS84_A_KM / ER_KM;
const B_ER = WGS84_B_KM / ER_KM;

/**
 * Where a scene-space ray first meets the WGS84 ellipsoid, as geodetic lat/lon
 * in degrees. Null when the ray misses or the Earth is behind the origin.
 *
 * `gmstRad` is the Earth group's rotation (EarthLayer sets `rotation.y = gmst`):
 * the ray is turned back by it into the Earth-fixed frame, swapped from scene
 * Y-up to ECEF (z = polar axis) with `sceneToSource`, then intersected with the
 * ellipsoid. The inverse of where `observerEcef` places a sea-level observer
 * under the Earth group, so a landing lands exactly where the marker draws.
 * `direction` need not be normalised.
 */
export function sceneRayToGeodetic(
  origin: V3,
  direction: V3,
  gmstRad: number,
): { latDeg: number; lonDeg: number } | null {
  // Undo the Earth group's rotation about scene Y (rotate by -gmst).
  const c = Math.cos(gmstRad);
  const s = Math.sin(gmstRad);
  const unrotate = (v: V3): V3 => ({ x: c * v.x - s * v.z, y: v.y, z: s * v.x + c * v.z });
  const o = sceneToSource(...xyz(unrotate(origin)));
  const d = sceneToSource(...xyz(unrotate(direction)));

  // Scale to a unit sphere: x,y by 1/a, z by 1/b. Ray parameters are unchanged.
  const ox = o.x / A_ER, oy = o.y / A_ER, oz = o.z / B_ER;
  const dx = d.x / A_ER, dy = d.y / A_ER, dz = d.z / B_ER;
  const qa = dx * dx + dy * dy + dz * dz;
  if (qa === 0) return null;
  const qb = 2 * (ox * dx + oy * dy + oz * dz);
  const qc = ox * ox + oy * oy + oz * oz - 1;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-qb - sq) / (2 * qa);
  const t2 = (-qb + sq) / (2 * qa);
  const t = t1 > 0 ? t1 : t2 > 0 ? t2 : NaN;
  if (!Number.isFinite(t)) return null;

  const hit = { x: o.x + t * d.x, y: o.y + t * d.y, z: o.z + t * d.z };
  const latDeg = geodeticLatAltFromEr(hit).latDeg;
  if (latDeg === null) return null;
  let lonDeg = Math.atan2(hit.y, hit.x) * DEG;
  if (lonDeg <= -180) lonDeg += 360;
  if (lonDeg > 180) lonDeg -= 360;
  return { latDeg, lonDeg };
}

function xyz(v: V3): [number, number, number] {
  return [v.x, v.y, v.z];
}
