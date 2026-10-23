import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCa, familyOf, launchOf, nearIdentical, secondsWithin, semiMajor, type ElsetLite } from './events-ca.js';

const e = (o: Partial<ElsetLite>): ElsetLite => ({ name: 'X-1', objectId: '2020-001A', meanMotion: 15.06, incDeg: 53, raanDeg: 100, ...o });

test('family and launch parsing', () => {
  assert.equal(familyOf('STARLINK-33816'), 'STARLINK');
  assert.equal(familyOf('COSMOS 1953'), 'COSMOS');
  assert.equal(familyOf('CZ-6A DEB'), 'CZ');
  assert.equal(launchOf('2020-001AB'), '2020-001');
});
test('semi-major axis of a 15.06 rev/day orbit is about 6,9xx km', () => {
  const a = semiMajor(15.06);
  assert.ok(a > 6900 && a < 6950, String(a));
});
test('near identical wraps RAAN at 360', () => {
  assert.ok(nearIdentical(e({ raanDeg: 359.995 }), e({ raanDeg: 0.003 })));
  assert.ok(!nearIdentical(e({ raanDeg: 10 }), e({ raanDeg: 10.5 })));
  assert.ok(!nearIdentical(e({ meanMotion: 15.06 }), e({ meanMotion: 15.07 })));
});
test('categories in priority order', () => {
  const A = e({ name: 'STARLINK-1', objectId: '2020-001A' });
  assert.equal(classifyCa(A, e({ name: 'STARLINK-2', objectId: '2020-001B', raanDeg: 40 }), 1, 9).cat, 'same_launch');
  assert.equal(classifyCa(A, e({ name: 'STARLINK-9', objectId: '2021-005A', raanDeg: 40 }), 1, 9).cat, 'same_family');
  assert.equal(classifyCa(A, e({ name: 'COSMOS 2', objectId: '2019-009A', raanDeg: 40 }), 1, 9).cat, 'crossing');
  assert.equal(classifyCa(A, e({ name: 'COSMOS 2', objectId: '2019-009A', raanDeg: 40 }), 1, 0.2).cat, 'co_moving');
  assert.equal(classifyCa(A, e({ name: 'STARLINK-2', objectId: '2020-001B' }), 1, 9).cat, 'twin');
});
test('time within 5 km: head-on at 14 km/s through the centre is 0.71 s, none outside', () => {
  assert.ok(Math.abs(secondsWithin(5, 0, 14) - 10 / 14) < 1e-12);
  assert.equal(secondsWithin(5, 5, 14), 0);
});
