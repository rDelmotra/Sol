import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { semiMajorAxisKmFromMeanMotion } from './elements.js';

describe('elements: semiMajorAxisKmFromMeanMotion', () => {
  it('returns null for null, zero, or negative mean motion', () => {
    assert.equal(semiMajorAxisKmFromMeanMotion(null), null);
    assert.equal(semiMajorAxisKmFromMeanMotion(0), null);
    assert.equal(semiMajorAxisKmFromMeanMotion(-1), null);
  });

  it('an ISS-like ~15.5 rev/day mean motion gives a LEO semi-major axis', () => {
    const sma = semiMajorAxisKmFromMeanMotion(15.5);
    assert.ok(sma !== null && Math.abs(sma - 6768) < 30, `sma ${String(sma)}`);
  });

  it('a GEO ~1.0027 rev/day mean motion gives a ~42164 km semi-major axis', () => {
    const sma = semiMajorAxisKmFromMeanMotion(1.0027);
    assert.ok(sma !== null && Math.abs(sma - 42164) < 50, `sma ${String(sma)}`);
  });

  it('matches the direct Kepler formula bit-for-bit', () => {
    const n = 14.2;
    const radPerSec = (n * 2 * Math.PI) / 86400;
    const expected = Math.cbrt(398600.4418 / (radPerSec * radPerSec));
    assert.equal(semiMajorAxisKmFromMeanMotion(n), expected);
  });
});
