import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEG, RAD, MU_KM3_S2 } from './units.js';

describe('units: DEG / RAD', () => {
  it('are exact reciprocal conversions of Math.PI', () => {
    assert.equal(DEG, 180 / Math.PI);
    assert.equal(RAD, Math.PI / 180);
  });

  it('round-trip a degree value through radians', () => {
    assert.ok(Math.abs(90 * RAD * DEG - 90) < 1e-12);
  });
});

describe('units: MU_KM3_S2', () => {
  it("is Earth's standard gravitational parameter, km^3/s^2", () => {
    assert.equal(MU_KM3_S2, 398600.4418);
  });
});
