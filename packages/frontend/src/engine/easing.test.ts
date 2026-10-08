import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { easeInOutCubic } from './easing';

describe('easeInOutCubic', () => {
  it('hits the endpoints and midpoint', () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(0.5), 0.5);
    assert.equal(easeInOutCubic(1), 1);
  });
  it('is point-symmetric: f(t) + f(1-t) = 1', () => {
    for (const t of [0.1, 0.25, 0.3, 0.45, 0.7, 0.9]) {
      assert.ok(Math.abs(easeInOutCubic(t) + easeInOutCubic(1 - t) - 1) < 1e-12);
    }
  });
});
