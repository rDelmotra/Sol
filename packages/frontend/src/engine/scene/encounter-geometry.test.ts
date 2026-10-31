import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ER_KM } from '@orbitwatch/orbital-core';
import { relativeApproachDirection, separationKm } from './encounter-geometry';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('encounter geometry', () => {
  it('separation is in km', () => {
    assert.ok(Math.abs(separationKm(v(1, 0, 0), v(1, 1 / ER_KM, 0)) - 1) < 1e-9);
  });
  it('approach direction is the other object\'s motion relative to the primary', () => {
    // primary moves +x, other moves +x and +y: relative motion is +y
    const d = relativeApproachDirection(v(1, 0, 0), v(1.001, 0, 0), v(1, 0.5, 0), v(1.001, 0.502, 0));
    assert.ok(d);
    assert.ok(Math.abs(d.x) < 1e-9 && Math.abs(d.y - 1) < 1e-9 && Math.abs(d.z) < 1e-9);
  });
  it('null when there is no relative motion', () => {
    assert.equal(relativeApproachDirection(v(1, 0, 0), v(1.1, 0, 0), v(2, 0, 0), v(2.1, 0, 0)), null);
  });
});
