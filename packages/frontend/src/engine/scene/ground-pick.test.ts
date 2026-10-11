import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { geodeticToEcefEr } from '@orbitwatch/orbital-core';
import { sourceToScene } from './frames';
import { sceneRayToGeodetic } from './ground-pick';

/** World position of a sea-level point under an Earth group rotated by gmst (as EarthLayer does). */
function worldPointOf(latDeg: number, lonDeg: number, gmst: number): THREE.Vector3 {
  const group = new THREE.Object3D();
  group.rotation.y = gmst;
  group.updateMatrixWorld(true);
  const e = geodeticToEcefEr({ latDeg, lonDeg, altKm: 0 });
  return group.localToWorld(sourceToScene(e.x, e.y, e.z));
}

describe('sceneRayToGeodetic', () => {
  const cases: [number, number, number][] = [
    [0, 0, 0],
    [45, 10, 1.3],
    [-33.9, 151.2, 4.0],
    [64.1, -21.9, 5.9],
    [89.5, 120, 2.2],
  ];

  for (const [lat, lon, gmst] of cases) {
    it(`round-trips a point under the rotated Earth group (${lat}, ${lon}, gmst ${gmst})`, () => {
      const target = worldPointOf(lat, lon, gmst);
      // Camera off to one side, so the ray is oblique (an ellipsoid vs sphere test).
      const origin = target.clone().multiplyScalar(2.5).add(new THREE.Vector3(0.3, -0.2, 0.4));
      const dir = target.clone().sub(origin);
      const out = sceneRayToGeodetic(origin, dir, gmst);
      assert.ok(out);
      assert.ok(Math.abs(out.latDeg - lat) < 1e-6, `lat ${out.latDeg} vs ${lat}`);
      assert.ok(Math.abs(out.lonDeg - lon) < 1e-6 || lat > 89, `lon ${out.lonDeg} vs ${lon}`);
    });
  }

  it('returns null when the ray misses the Earth', () => {
    assert.equal(sceneRayToGeodetic({ x: 0, y: 0, z: 3 }, { x: 1, y: 0, z: 0 }, 0), null);
  });

  it('returns null when the Earth is behind the ray', () => {
    assert.equal(sceneRayToGeodetic({ x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 1 }, 0), null);
  });

  it('a straight-down polar ray lands at latitude 90', () => {
    // Looking straight down at the pole from scene +Y must land at latitude 90.
    const out = sceneRayToGeodetic({ x: 0, y: 3, z: 0 }, { x: 0, y: -1, z: 0 }, 0.7);
    assert.ok(out);
    assert.ok(Math.abs(out.latDeg - 90) < 1e-9);
  });
});
