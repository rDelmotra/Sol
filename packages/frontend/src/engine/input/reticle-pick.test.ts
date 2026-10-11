import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cssDistSqInCircle, rankReticleHits } from './reticle-pick';

describe('cssDistSqInCircle', () => {
  it('is a circle, not a square: the corner of the bounding box is outside', () => {
    assert.equal(cssDistSqInCircle(10, 0, 1, 1, 10), 100);
    assert.equal(cssDistSqInCircle(9, 9, 1, 1, 10), -1); // inside the square, outside the circle
    assert.equal(cssDistSqInCircle(7, 7, 1, 1, 10), 98);
  });

  it('measures in CSS pixels when the pick target is squashed', () => {
    // Canvas 1024 wide over a 512 target: 0.5 pick px per CSS px horizontally.
    assert.equal(cssDistSqInCircle(5, 0, 0.5, 1, 10), 100);
    assert.equal(cssDistSqInCircle(6, 0, 0.5, 1, 10), -1);
    assert.equal(cssDistSqInCircle(0, 10, 0.5, 1, 10), 100);
  });
});

describe('rankReticleHits', () => {
  it('puts the object nearer the camera first even if it is further from the crosshair', () => {
    const hits = new Map([[1, 4], [2, 400]]);
    const cam = new Map([[1, 100], [2, 1]]);
    assert.deepEqual(rankReticleHits(hits, (i) => cam.get(i)!), [2, 1]);
  });

  it('within one depth band, the object nearer the crosshair wins', () => {
    const hits = new Map([[1, 400], [2, 4]]);
    const cam = new Map([[1, 1.0], [2, 1.02]]);
    assert.deepEqual(rankReticleHits(hits, (i) => cam.get(i)!), [2, 1]);
  });
});
