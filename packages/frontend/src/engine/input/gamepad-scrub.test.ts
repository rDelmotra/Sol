import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PadAction } from '../../bindings/bindings';
import type { TimeField } from '../../time/time-fields';
import { GamepadScrubDriver, type ScrubStore } from './gamepad-scrub';
import { SCRUB_REPEAT_DELAY_MS } from './scrub-repeat';

const WALL = Date.UTC(2026, 9, 12, 12, 0, 0);

function rig(over: Partial<ScrubStore> = {}, simNow = WALL) {
  const calls: string[] = [];
  const store: ScrubStore = {
    scrubberMode: true,
    scrubFocusOnReset: false,
    scrubField: 'day',
    setScrubFocusOnReset(on) { calls.push(`focusReset:${on}`); store.scrubFocusOnReset = on; },
    setScrubField(f) { calls.push(`field:${f}`); store.scrubField = f; store.scrubFocusOnReset = false; },
    scrubPreview: (d) => calls.push(`preview:${d.toISOString()}`),
    reviewAt: (d) => calls.push(`review:${d.toISOString()}`),
    toggleAnalysisPanel: () => calls.push('analysis'),
    toggleFocusPanel: () => calls.push('focus'),
    ...over,
  };
  let sim = simNow;
  const driver = new GamepadScrubDriver({
    getStore: () => store,
    simNow: () => sim,
    wallNow: () => WALL,
    toggleLanding: () => calls.push('land'),
  });
  const frame = (actions: PadAction[] = [], dpadVertical = 0, dtMs = 16) => driver.step({ actions, dpadVertical }, dtMs);
  return { store, calls, driver, frame, setSim: (t: number) => (sim = t) };
}

describe('D-pad with the scrubber closed', () => {
  it('◄ ► toggle the panes, ▼ lands', () => {
    const { calls, frame } = rig({ scrubberMode: false });
    frame(['dpadLeft']);
    frame(['dpadRight']);
    frame(['dpadDown']);
    assert.deepEqual(calls, ['analysis', 'focus', 'land']);
  });
});

describe('D-pad with the scrubber open: field focus', () => {
  it('◄ ► walk the fields', () => {
    const { calls, frame } = rig();
    frame(['dpadRight']);
    frame(['dpadLeft']);
    assert.deepEqual(calls, ['field:hour', 'field:day']);
  });

  it('► past SECOND parks on ↺ only while the clock is displaced', () => {
    const displaced = rig({ scrubField: 'second' as TimeField }, WALL - 60_000);
    displaced.frame(['dpadRight']);
    assert.deepEqual(displaced.calls, ['focusReset:true']);

    const live = rig({ scrubField: 'second' as TimeField });
    live.frame(['dpadRight']);
    assert.deepEqual(live.calls, ['field:year']); // wraps, no ↺
  });

  it('► on ↺ stays; ◄ on ↺ comes back to the field row', () => {
    const { calls, frame } = rig({ scrubFocusOnReset: true });
    frame(['dpadRight']);
    assert.deepEqual(calls, []);
    frame(['dpadLeft']);
    assert.deepEqual(calls, ['focusReset:false']);
  });

  it('▲ ▼ do nothing while ↺ has focus', () => {
    const { calls, frame } = rig({ scrubFocusOnReset: true });
    frame([], 1);
    frame([], 1, 1000);
    assert.deepEqual(calls, []);
  });

  it('▼ does not land while scrubbing', () => {
    const { calls, frame } = rig();
    frame(['dpadDown']);
    assert.deepEqual(calls, []);
  });
});

describe('D-pad with the scrubber open: stepping', () => {
  it('a fresh ▲ press previews one step from the clock; releasing commits it', () => {
    const { calls, frame } = rig();
    frame([], 1);
    assert.deepEqual(calls, ['preview:2026-10-13T12:00:00.000Z']);
    frame([], 0);
    assert.deepEqual(calls.slice(1), ['review:2026-10-13T12:00:00.000Z']);
  });

  it('▼ steps back; holding repeats after the delay', () => {
    const { calls, frame } = rig();
    frame([], -1);
    frame([], -1, SCRUB_REPEAT_DELAY_MS - 20);
    assert.equal(calls.length, 1);
    frame([], -1, 200);
    assert.ok(calls.length > 1);
    assert.equal(calls[0], 'preview:2026-10-11T12:00:00.000Z');
  });

  it('closing the scrubber mid-hold commits the landed time', () => {
    const { store, calls, frame } = rig();
    frame([], 1);
    store.scrubberMode = false;
    frame();
    assert.deepEqual(calls.slice(1), ['review:2026-10-13T12:00:00.000Z']);
  });

  it('release() (pad unplugged) commits an active hold, and is silent when idle', () => {
    const idle = rig();
    idle.driver.release();
    assert.deepEqual(idle.calls, []);
    const held = rig();
    held.frame([], 1);
    held.driver.release();
    assert.equal(held.calls[1], 'review:2026-10-13T12:00:00.000Z');
  });

  it('steps the active field', () => {
    const { calls, frame } = rig({ scrubField: 'hour' as TimeField });
    frame([], 1);
    assert.deepEqual(calls, ['preview:2026-10-12T13:00:00.000Z']);
  });
});
