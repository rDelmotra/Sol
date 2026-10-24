import test from 'node:test';
import assert from 'node:assert/strict';
import { floorSigma, hardBodyRadiusKm, isManoeuvrable, matchEvents, quantile, SIGMA_FLOOR, batchTimeMs } from './forward-lib.js';

test('matching: same pair within the tolerance, nearest first, one to one', () => {
  const prev = [{ a: 1, b: 2, tca: 1000 }, { a: 1, b: 2, tca: 5400_000 }, { a: 3, b: 4, tca: 2000 }];
  const next = [{ a: 2, b: 1, tca: 5400_000 + 30_000 }, { a: 1, b: 2, tca: 1000 + 59_000 }, { a: 3, b: 4, tca: 2000 + 61_000 }, { a: 5, b: 6, tca: 0 }];
  assert.deepEqual([...matchEvents(prev, next)], [1, 0, -1, -1]);
});
test('matching: two nearby events of one pair are not crossed over, and one old event matches only once', () => {
  const prev = [{ a: 1, b: 2, tca: 0 }, { a: 1, b: 2, tca: 50_000 }];
  const next = [{ a: 1, b: 2, tca: 40_000 }, { a: 1, b: 2, tca: 10_000 }];
  assert.deepEqual([...matchEvents(prev, next)], [1, 0]);
  assert.deepEqual([...matchEvents([{ a: 1, b: 2, tca: 0 }], [{ a: 1, b: 2, tca: 1000 }, { a: 1, b: 2, tca: 2000 }])], [0, -1]);
});
test('hard-body radius by type and size', () => {
  assert.equal(hardBodyRadiusKm({ noradId: 1, name: 'X', objectType: 'unknown', rcsSize: 'LARGE' }), 0.003);
  assert.equal(hardBodyRadiusKm({ noradId: 1, name: 'X', objectType: 'debris', rcsSize: 'SMALL' }), 0.00005);
  assert.equal(hardBodyRadiusKm({ noradId: 1, name: 'X', objectType: 'rocket_body', rcsSize: 'LARGE' }), 0.005);
  assert.equal(hardBodyRadiusKm({ noradId: 25544, name: 'ISS (ZARYA)', objectType: 'unknown', rcsSize: 'LARGE' }), 0.055);
  assert.equal(hardBodyRadiusKm({ noradId: 2, name: 'Y', objectType: 'unknown', rcsSize: null }), 0.002);
});
test('floor and manoeuvrable label', () => {
  assert.deepEqual(floorSigma([0.04, 0.28, 0.04]), SIGMA_FLOOR);
  assert.deepEqual(floorSigma([0.5, 3, 0.1]), [0.5, 3, 0.3]);
  assert.equal(isManoeuvrable({ name: 'STARLINK-1234', objectType: 'unknown' }), true);
  assert.equal(isManoeuvrable({ name: 'STARLINK-1234 DEB', objectType: 'debris' }), false);
  assert.equal(isManoeuvrable({ name: 'COSMOS 2251 DEB', objectType: 'debris' }), false);
  assert.equal(isManoeuvrable({ name: 'ONEWEB-0012', objectType: 'unknown' }), true);
});
test('quantile and batch time', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(new Date(batchTimeMs('2026-10-12')).toISOString(), '2026-10-12T12:00:00.000Z');
});
