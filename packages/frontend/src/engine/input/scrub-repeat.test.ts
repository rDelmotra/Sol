import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ScrubRepeat, SCRUB_REPEAT_DELAY_MS, SCRUB_REPEAT_INTERVAL_MS } from './scrub-repeat';

/** Hold `dir` for `ms` in 10 ms frames after the press frame; total steps. */
function hold(r: ScrubRepeat, dir: number, ms: number): number {
  let total = r.step(dir, 16).steps;
  for (let t = 0; t < ms; t += 10) total += r.step(dir, 10).steps;
  return total;
}

describe('ScrubRepeat', () => {
  it('a tap is exactly one step', () => {
    const r = new ScrubRepeat();
    assert.equal(r.step(1, 16).steps, 1);
    assert.deepEqual(r.step(0, 16), { steps: 0, released: 1 });
  });

  it('no repeat before the delay', () => {
    assert.equal(hold(new ScrubRepeat(), -1, SCRUB_REPEAT_DELAY_MS - 20), 1);
  });

  it('second step at the delay, then one per interval', () => {
    assert.equal(hold(new ScrubRepeat(), 1, SCRUB_REPEAT_DELAY_MS), 2);
    assert.equal(hold(new ScrubRepeat(), 1, SCRUB_REPEAT_DELAY_MS + 3 * SCRUB_REPEAT_INTERVAL_MS), 5);
  });

  it('a long frame catches up with several steps at once', () => {
    const r = new ScrubRepeat();
    r.step(1, 16);
    assert.equal(r.step(1, SCRUB_REPEAT_DELAY_MS + 2 * SCRUB_REPEAT_INTERVAL_MS).steps, 3);
  });

  it('flipping direction releases the old one and steps the new one once', () => {
    const r = new ScrubRepeat();
    r.step(1, 16);
    assert.deepEqual(r.step(-1, 16), { steps: 1, released: 1 });
    assert.equal(r.heldDir, -1);
  });
});
