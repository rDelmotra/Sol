import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STEP_COMMIT_MS, createTimeStepper } from './time-stepper';

function harness(startMs: number) {
  const previews: number[] = [];
  const commits: number[] = [];
  let pending: { fn: () => void; ms: number; id: number } | null = null;
  let nextId = 1;
  const cleared: number[] = [];
  const stepper = createTimeStepper({
    simTimeMs: () => startMs,
    preview: (d) => previews.push(d.getTime()),
    commit: (d) => commits.push(d.getTime()),
    setTimeout: (fn, ms) => (pending = { fn, ms, id: nextId++ }).id,
    clearTimeout: (h) => {
      cleared.push(h as number);
      if (pending && pending.id === h) pending = null;
    },
  });
  return { stepper, previews, commits, cleared, fire: () => { const p = pending; pending = null; p?.fn(); }, hasPending: () => pending !== null };
}

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

describe('createTimeStepper', () => {
  it('previews every step and accumulates from the draft, not the clock', () => {
    const h = harness(T0);
    h.stepper.step('hour', 1);
    h.stepper.step('hour', 1);
    h.stepper.step('minute', -1);
    assert.deepEqual(h.previews, [T0 + 3_600_000, T0 + 7_200_000, T0 + 7_200_000 - 60_000]);
    assert.deepEqual(h.commits, []);
  });

  it('commits once, after the quiet period, with the last draft', () => {
    const h = harness(T0);
    h.stepper.step('second', 1);
    h.stepper.step('second', 1);
    assert.equal(h.cleared.length, 1); // the first timer was replaced
    h.fire();
    assert.deepEqual(h.commits, [T0 + 2000]);
    assert.equal(h.hasPending(), false);
  });

  it('starts a fresh draft from the clock after a commit', () => {
    const h = harness(T0);
    h.stepper.step('day', 1);
    h.fire();
    h.stepper.step('day', 1);
    assert.equal(h.previews[1], T0 + 86_400_000);
  });

  it('cancel drops the pending commit', () => {
    const h = harness(T0);
    h.stepper.step('year', 1);
    h.stepper.cancel();
    assert.equal(h.hasPending(), false);
    h.fire();
    assert.deepEqual(h.commits, []);
  });

  it('waits STEP_COMMIT_MS', () => {
    assert.equal(STEP_COMMIT_MS, 220);
  });
});
