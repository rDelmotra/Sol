import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planUnfollow, unfollowStep, UNFOLLOW_MS } from './UnfollowAnimator';

describe('planUnfollow', () => {
  it('needs no pull-back at or beyond the minimum distance', () => {
    assert.equal(planUnfollow(2, 2, 0), null);
    assert.equal(planUnfollow(3, 2, 0), null);
  });
  it('plans an ease out to the minimum distance', () => {
    assert.deepEqual(planUnfollow(0.5, 2, 100), { startTime: 100, duration: UNFOLLOW_MS, startDist: 0.5, endDist: 2 });
  });
});

describe('unfollowStep', () => {
  const plan = { startTime: 1000, duration: 400, startDist: 1, endDist: 3 };
  it('starts at the start distance and ends at the end distance', () => {
    assert.deepEqual(unfollowStep(plan, 1000), { distance: 1, done: false });
    assert.deepEqual(unfollowStep(plan, 1400), { distance: 3, done: true });
    assert.deepEqual(unfollowStep(plan, 9999), { distance: 3, done: true });
  });
  it('is the midpoint halfway (smoothstep is symmetric) and clamps before the start', () => {
    assert.equal(unfollowStep(plan, 1200).distance, 2);
    assert.equal(unfollowStep(plan, 0).distance, 1);
  });
});
