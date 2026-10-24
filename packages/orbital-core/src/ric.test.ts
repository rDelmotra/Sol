import test from 'node:test';
import assert from 'node:assert/strict';
import { chi3Cdf, erf, mahalanobisDiag, ricBasis, toRic, type V3 } from './ric.js';

test('RIC basis of a circular equatorial orbit: radial=x, in-track=y, cross=z', () => {
  const b = ricBasis([7000, 0, 0], [0, 7.5, 0])!;
  assert.deepEqual(toRic([1, 2, 3], b).map((q) => Math.round(q * 1e9) / 1e9), [1, 2, 3]);
});
test('RIC basis is orthonormal and follows a rotated orbit', () => {
  const b = ricBasis([0, 7000, 0], [-7.5, 0, 0])!;
  const d: V3 = [0, 5, 0]; // along the radius
  assert.deepEqual(toRic(d, b).map((q) => Math.round(q * 1e9) / 1e9), [5, 0, 0]);
  const e: V3 = [-4, 0, 0]; // along the velocity
  assert.deepEqual(toRic(e, b).map((q) => Math.round(q * 1e9) / 1e9), [0, 4, 0]);
  const f: V3 = [0, 0, 2];
  assert.deepEqual(toRic(f, b).map((q) => Math.round(q * 1e9) / 1e9), [0, 0, 2]);
});
test('parallel position and velocity gives no basis', () => {
  assert.equal(ricBasis([1, 0, 0], [2, 0, 0]), null);
});
test('Mahalanobis distance', () => {
  assert.equal(mahalanobisDiag([3, 0, 0], [1, 1, 1]), 3);
  assert.ok(Math.abs(mahalanobisDiag([1, 2, 2], [1, 2, 2]) - Math.sqrt(3)) < 1e-12);
});
test('erf and chi-square(3) known values', () => {
  assert.ok(Math.abs(erf(1) - 0.8427007929497149) < 1e-12);
  assert.ok(Math.abs(erf(3) - 0.9999779095030014) < 1e-12);
  assert.ok(Math.abs(chi3Cdf(1) - 0.19875) < 1e-4); // inside 1 sigma
  assert.ok(Math.abs(chi3Cdf(4) - 0.73854) < 1e-4);
  assert.ok(Math.abs(chi3Cdf(9) - 0.97071) < 1e-4);
});
