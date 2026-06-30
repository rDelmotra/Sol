import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_PROPAGATION_DAYS,
  MAX_TSINCE_MIN,
  MINUTES_PER_DAY,
  FUTURE_HORIZON_DAYS,
  tsinceMinutes,
  withinPropagationWindow,
} from './propagation-limits';

// These bounds are the ONLY thing standing between a far time-scrub and a wedged SGP4
// worker (deep-space resonance integration cost ∝ |tsince|). Pin them down hard.

const EPOCH_JD = 2461000; // ~a recent element-set epoch; only the day-delta matters here

describe('propagation-limits: tsinceMinutes', () => {
  it('converts a whole-day Julian delta to minutes', () => {
    assert.equal(tsinceMinutes(EPOCH_JD + 1, EPOCH_JD), MINUTES_PER_DAY);
    assert.equal(tsinceMinutes(EPOCH_JD - 2, EPOCH_JD), -2 * MINUTES_PER_DAY);
    assert.equal(tsinceMinutes(EPOCH_JD, EPOCH_JD), 0);
  });
});

describe('propagation-limits: withinPropagationWindow', () => {
  it('accepts times inside the cap (both directions)', () => {
    assert.equal(withinPropagationWindow(EPOCH_JD + 5, EPOCH_JD), true);
    assert.equal(withinPropagationWindow(EPOCH_JD - 5, EPOCH_JD), true);
    assert.equal(withinPropagationWindow(EPOCH_JD, EPOCH_JD), true);
  });

  it('accepts exactly at the cap boundary, rejects just beyond (symmetric)', () => {
    assert.equal(withinPropagationWindow(EPOCH_JD + MAX_PROPAGATION_DAYS, EPOCH_JD), true);
    assert.equal(withinPropagationWindow(EPOCH_JD - MAX_PROPAGATION_DAYS, EPOCH_JD), true);
    assert.equal(withinPropagationWindow(EPOCH_JD + MAX_PROPAGATION_DAYS + 1, EPOCH_JD), false);
    assert.equal(withinPropagationWindow(EPOCH_JD - MAX_PROPAGATION_DAYS - 1, EPOCH_JD), false);
  });

  it('rejects far future and far past (the hang case)', () => {
    assert.equal(withinPropagationWindow(EPOCH_JD + 365 * 100, EPOCH_JD), false); // +100 yr
    assert.equal(withinPropagationWindow(EPOCH_JD - 365 * 100, EPOCH_JD), false); // -100 yr
  });

  it('rejects a non-finite Julian day (Invalid Date → NaN → never propagated)', () => {
    assert.equal(withinPropagationWindow(NaN, EPOCH_JD), false);
    assert.equal(withinPropagationWindow(Infinity, EPOCH_JD), false);
  });

  it('honors a custom cap', () => {
    const capMin = 1 * MINUTES_PER_DAY; // 1-day window
    assert.equal(withinPropagationWindow(EPOCH_JD + 0.5, EPOCH_JD, capMin), true);
    assert.equal(withinPropagationWindow(EPOCH_JD + 2, EPOCH_JD, capMin), false);
  });
});

describe('propagation-limits: invariants', () => {
  it('the render horizon is strictly inside the worker cap', () => {
    // Satellites shown inside the horizon must never be clipped by the hard cap.
    assert.ok(FUTURE_HORIZON_DAYS < MAX_PROPAGATION_DAYS);
  });

  it('MAX_TSINCE_MIN matches the day cap', () => {
    assert.equal(MAX_TSINCE_MIN, MAX_PROPAGATION_DAYS * MINUTES_PER_DAY);
  });
});
