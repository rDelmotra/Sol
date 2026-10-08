import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { simClock } from './SimClock';

const T0 = Date.UTC(2026, 0, 1);

describe('simClock', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: T0 });
    simClock.reset();
  });
  afterEach(() => {
    mock.timers.reset();
    simClock.reset();
  });

  it('tracks Date.now() at rate 1', () => {
    assert.equal(simClock.getRate(), 1);
    assert.equal(simClock.now(), T0);
    mock.timers.tick(5000);
    assert.equal(simClock.now(), T0 + 5000);
    assert.equal(simClock.date().getTime(), T0 + 5000);
  });

  it('setRate scales elapsed time from the moment of the change', () => {
    mock.timers.tick(1000);
    simClock.setRate(10);
    assert.equal(simClock.getRate(), 10);
    assert.equal(simClock.now(), T0 + 1000);
    mock.timers.tick(2000);
    assert.equal(simClock.now(), T0 + 1000 + 20000);
  });

  it('setRate ignores non-finite rates', () => {
    simClock.setRate(4);
    simClock.setRate(NaN);
    simClock.setRate(Infinity);
    assert.equal(simClock.getRate(), 4);
  });

  it('jumpTo moves sim time and keeps running at the current rate', () => {
    const target = new Date(T0 + 86_400_000);
    simClock.jumpTo(target);
    assert.equal(simClock.now(), target.getTime());
    mock.timers.tick(1000);
    assert.equal(simClock.now(), target.getTime() + 1000);
    simClock.setRate(2);
    mock.timers.tick(1000);
    assert.equal(simClock.now(), target.getTime() + 1000 + 2000);
  });

  it('jumpTo ignores invalid dates', () => {
    simClock.jumpTo(new Date(NaN));
    assert.equal(simClock.now(), T0);
  });

  it('reset returns to wall clock at rate 1', () => {
    simClock.setRate(60);
    simClock.jumpTo(new Date(T0 - 1_000_000));
    mock.timers.tick(500);
    simClock.reset();
    assert.equal(simClock.getRate(), 1);
    assert.equal(simClock.now(), T0 + 500);
  });
});
