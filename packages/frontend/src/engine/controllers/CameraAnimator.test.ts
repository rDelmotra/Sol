import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { CameraAnimator } from './CameraAnimator';

// The joyride camera math is the subtlest thing NavigationController depends on
// (velocity-aligned seat + look-ahead, with a radial fallback when velocity is zero).
// These pin the entry/seat geometry so an extraction or constant tweak can't drift it
// silently. Values derived from CameraAnimator's own clamps:
//   lookAhead = clamp(radiusEr * 0.04,    0.12,   4.0)
//   seat      = clamp(radiusEr * 0.00008, 0.00045, 0.004)

const EPS = 1e-9;

function assertVecClose(actual: THREE.Vector3, expected: [number, number, number]): void {
  assert.ok(Math.abs(actual.x - expected[0]) < EPS, `x: ${actual.x} ≠ ${expected[0]}`);
  assert.ok(Math.abs(actual.y - expected[1]) < EPS, `y: ${actual.y} ≠ ${expected[1]}`);
  assert.ok(Math.abs(actual.z - expected[2]) < EPS, `z: ${actual.z} ≠ ${expected[2]}`);
}

describe('CameraAnimator joyride vectors', () => {
  it('getJoyrideEntryTarget aims along the velocity at the look-ahead distance', () => {
    const cam = new THREE.PerspectiveCamera(27, 1, 0.01, 1000); // FOV matches render/Camera.ts (not asserted)
    const ctrl = new CameraAnimator(cam);

    const pos = new THREE.Vector3(2, 0, 0); // radius 2 ER → lookAhead = 0.12
    const vel = new THREE.Vector3(0, 3, 0); // forward normalizes to (0, 1, 0)
    const out = new THREE.Vector3();

    ctrl.getJoyrideEntryTarget(pos, vel, out);
    assertVecClose(out, [2, 0.12, 0]);
  });

  it('getJoyrideEntryTarget falls back to the radial direction when velocity is zero', () => {
    const cam = new THREE.PerspectiveCamera(27, 1, 0.01, 1000); // FOV matches render/Camera.ts (not asserted)
    const ctrl = new CameraAnimator(cam);

    const pos = new THREE.Vector3(0, 2, 0); // radial up = (0, 1, 0); lookAhead = 0.12
    const vel = new THREE.Vector3(0, 0, 0);
    const out = new THREE.Vector3();

    ctrl.getJoyrideEntryTarget(pos, vel, out);
    assertVecClose(out, [0, 2.12, 0]);
  });

  it('updateJoyride seats the camera along the radial and looks ahead down velocity', () => {
    const cam = new THREE.PerspectiveCamera(27, 1, 0.01, 1000); // FOV matches render/Camera.ts (not asserted)
    const ctrl = new CameraAnimator(cam);

    const pos = new THREE.Vector3(2, 0, 0); // radial = (1,0,0); seat = 0.00045
    const vel = new THREE.Vector3(0, 5, 0); // forward = (0,1,0); lookAhead = 0.12
    const out = new THREE.Vector3();

    ctrl.updateJoyride(pos, vel, out);

    // Seat: camera sits just outside the object along the radial.
    assertVecClose(cam.position, [2.00045, 0, 0]);
    // Look target: seat + forward * lookAhead.
    assertVecClose(out, [2.00045, 0.12, 0]);
  });
});
