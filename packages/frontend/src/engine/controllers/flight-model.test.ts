import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ER_KM } from '@orbitwatch/orbital-core';
import * as THREE from 'three';
import {
  FLIGHT,
  FlightModel,
  GEAR_COUNT,
  clampIntent,
  gearUnitsPerSec,
  proximityScales,
  rightVector,
  shiftGear,
} from './flight-model';

const UP = new THREE.Vector3(0, 1, 0);
const Q = new THREE.Quaternion();

describe('flight-model gears and scales', () => {
  it('gears clamp to the table', () => {
    assert.equal(shiftGear(0, -1), 0);
    assert.equal(shiftGear(GEAR_COUNT - 1, 1), GEAR_COUNT - 1);
    assert.equal(shiftGear(FLIGHT.defaultGear, 1), FLIGHT.defaultGear + 1);
  });

  it('gears are strictly increasing', () => {
    for (let i = 1; i < FLIGHT.gearsMps.length; i++) assert.ok(FLIGHT.gearsMps[i] > FLIGHT.gearsMps[i - 1]);
    assert.equal(GEAR_COUNT, FLIGHT.gearsMps.length);
    assert.ok(FLIGHT.defaultGear >= 0 && FLIGHT.defaultGear < GEAR_COUNT);
  });

  it('a gear in scene units per second is its m/s over the Earth radius in metres', () => {
    for (let g = 0; g < GEAR_COUNT; g++) {
      assert.ok(Math.abs(gearUnitsPerSec(g) - FLIGHT.gearsMps[g] / (ER_KM * 1000)) < 1e-12);
    }
  });

  it('slows near the surface and is full speed above the ramp', () => {
    assert.equal(proximityScales(FLIGHT.minRadius).speed, FLIGHT.proximityFloor);
    assert.equal(proximityScales(FLIGHT.minRadius).turn, 0.5);
    assert.deepEqual(proximityScales(5), { speed: 1, turn: 1 });
  });

  it('diagonals are not faster; forward dash is capped at 2', () => {
    const c = clampIntent({ x: 1, vert: 1, z: 3 });
    assert.ok(Math.abs(Math.hypot(c.x, c.vert) - 1) < 1e-12);
    assert.equal(c.z, 2);
  });
});

describe('rightVector', () => {
  it('is forward × up normally', () => {
    const r = rightVector(new THREE.Vector3(0, 0, -1), UP, Q, new THREE.Vector3());
    assert.ok(r.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-12);
  });

  it('falls back to the camera right axis looking straight up', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2);
    const r = rightVector(new THREE.Vector3(0, 1, 0), UP, q, new THREE.Vector3());
    assert.ok(Number.isFinite(r.x) && Math.abs(r.length() - 1) < 1e-9);
    assert.ok(r.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9);
  });
});

describe('FlightModel', () => {
  const basis = () => ({
    pos: new THREE.Vector3(0, 0, 3),
    fwd: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
  });

  it('velocity glides toward the target (inertia), then holds it', () => {
    const m = new FlightModel();
    const b = basis();
    const out = new THREE.Vector3();
    m.stepMove({ x: 0, z: 1, vert: 0 }, 3, 1, 1 / 60, b.pos, b.fwd, b.right, UP, out);
    const target = gearUnitsPerSec(3);
    assert.ok(m.velocity.length() < target * 0.2, 'first frame is a fraction of full speed');
    for (let i = 0; i < 300; i++) m.stepMove({ x: 0, z: 1, vert: 0 }, 3, 1, 1 / 60, b.pos, b.fwd, b.right, UP, out);
    assert.ok(Math.abs(m.velocity.length() - target) / target < 1e-6);
    assert.ok(m.velocity.z < 0, 'moves along the view direction');
  });

  it('drifts on after release instead of stopping dead', () => {
    const m = new FlightModel();
    const b = basis();
    const out = new THREE.Vector3();
    for (let i = 0; i < 120; i++) m.stepMove({ x: 1, z: 0, vert: 0 }, 3, 1, 1 / 60, b.pos, b.fwd, b.right, UP, out);
    const moved = m.stepMove({ x: 0, z: 0, vert: 0 }, 3, 1, 1 / 60, b.pos, b.fwd, b.right, UP, out);
    assert.ok(moved && moved.x > 0);
  });

  it('bumps the surface clamp instead of tunnelling, but can climb out from below it', () => {
    const m = new FlightModel();
    const out = new THREE.Vector3();
    const pos = new THREE.Vector3(0, 0, FLIGHT.minRadius + 1e-4);
    const down = new THREE.Vector3(0, 0, -1);
    let moved: THREE.Vector3 | null = out;
    for (let i = 0; i < 60 && moved; i++) {
      moved = m.stepMove({ x: 0, z: 1, vert: 0 }, 9, 1, 0.05, pos, down, new THREE.Vector3(1, 0, 0), UP, out);
      if (moved) pos.add(moved);
    }
    assert.equal(moved, null);
    assert.ok(pos.length() >= FLIGHT.minRadius);
    assert.equal(m.velocity.length(), 0);

    const low = new FlightModel();
    const below = new THREE.Vector3(0, 0, 1.02);
    const up = low.stepMove({ x: 0, z: 1, vert: 0 }, 5, 1, 0.05, below, new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), UP, out);
    assert.ok(up && up.z > 0);
  });

  it('look never pitches over the pole', () => {
    const m = new FlightModel();
    const fwd = new THREE.Vector3(0, 0, -1);
    for (let i = 0; i < 600; i++) m.stepLook(0, -1, 1 / 60, 1, fwd, UP, Q);
    assert.ok(Math.abs(fwd.dot(UP)) <= FLIGHT.maxPitchDot + 1e-9);
    assert.ok(Math.abs(fwd.length() - 1) < 1e-9);
  });
});
