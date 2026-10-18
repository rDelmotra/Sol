import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DsoSnapshot } from '@orbitwatch/contracts';
import { interpolateDsoPosition } from './dso-interpolator';

const T0 = Date.UTC(2026, 3, 3, 0, 8);
const STEP = 10 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const snapshot = {
  validTo: iso(T0 + 2 * STEP),
  stateVectors: [
    [iso(T0), 0, 0, 0, 0, 0, 0],
    [iso(T0 + STEP), 10, 20, 30, 1, 2, 3],
    [iso(T0 + 2 * STEP), 20, 40, 60, 2, 4, 6],
  ],
} as unknown as DsoSnapshot;

test('returns null before the first sample (mission not launched yet)', () => {
  assert.equal(interpolateDsoPosition(snapshot, T0 - 1), null);
  assert.equal(interpolateDsoPosition(snapshot, T0 - 30 * 86_400_000), null);
});

test('first sample time returns the first sample', () => {
  assert.deepEqual(interpolateDsoPosition(snapshot, T0), { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
});

test('interpolates linearly inside the window', () => {
  const p = interpolateDsoPosition(snapshot, T0 + STEP / 2);
  assert.deepEqual(p, { x: 5, y: 10, z: 15, vx: 0.5, vy: 1, vz: 1.5 });
});

test('null after validTo plus grace, held within grace', () => {
  const end = T0 + 2 * STEP;
  assert.equal(interpolateDsoPosition(snapshot, end + 1), null);
  assert.equal(interpolateDsoPosition(snapshot, end + 1000, { validToGraceMs: 5000 })?.x, 20);
  assert.equal(interpolateDsoPosition(snapshot, end + 6000, { validToGraceMs: 5000 }), null);
});

test('single sample: null before it, the sample at/after it', () => {
  const one = { validTo: iso(T0 + STEP), stateVectors: [[iso(T0), 1, 2, 3, 0, 0, 0]] } as unknown as DsoSnapshot;
  assert.equal(interpolateDsoPosition(one, T0 - 1), null);
  assert.equal(interpolateDsoPosition(one, T0 + 1)?.x, 1);
});
