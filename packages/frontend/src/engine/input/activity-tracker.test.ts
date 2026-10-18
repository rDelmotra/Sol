import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVITY_EVENTS,
  ActivityTracker,
  PAD_ACTIVITY_DEADZONE,
  padHasInput,
  type PadLike,
} from './activity-tracker';

function setup(over: { pads?: () => ArrayLike<PadLike | null> | null } = {}) {
  const target = new EventTarget();
  let now = 1000;
  const tracker = new ActivityTracker({ target, now: () => now, hasFocus: () => true, getPads: over.pads ?? (() => null) });
  return { target, tracker, advance: (ms: number) => (now += ms), clock: () => now };
}

describe('ActivityTracker', () => {
  it('starts "just active", so the boot runs at full rate', () => {
    const { tracker } = setup();
    assert.equal(tracker.lastActivityMs, 1000);
    assert.equal(tracker.windowFocused, true);
  });
  it('every input event stamps the time', () => {
    const { target, tracker, advance, clock } = setup();
    for (const type of ACTIVITY_EVENTS) {
      advance(100);
      target.dispatchEvent(new Event(type));
      assert.equal(tracker.lastActivityMs, clock(), type);
    }
  });
  it('covers pointer, wheel, key, touch, pad and resize', () => {
    for (const t of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart', 'gamepadconnected', 'resize']) {
      assert.ok((ACTIVITY_EVENTS as readonly string[]).includes(t), t);
    }
  });
  it('focus and blur flip windowFocused; focus also counts as activity', () => {
    const { target, tracker, advance, clock } = setup();
    advance(500);
    target.dispatchEvent(new Event('blur'));
    assert.equal(tracker.windowFocused, false);
    assert.equal(tracker.lastActivityMs, 1000, 'blur is not activity');
    advance(500);
    target.dispatchEvent(new Event('focus'));
    assert.equal(tracker.windowFocused, true);
    assert.equal(tracker.lastActivityMs, clock());
  });
  it('mark() counts as activity', () => {
    const { tracker, advance, clock } = setup();
    advance(3000);
    tracker.mark();
    assert.equal(tracker.lastActivityMs, clock());
  });
  it('pollGamepad stamps only while a pad has input', () => {
    let pads: ArrayLike<PadLike | null> | null = null;
    const { tracker, advance, clock } = setup({ pads: () => pads });
    advance(100);
    tracker.pollGamepad();
    assert.equal(tracker.lastActivityMs, 1000, 'no pad');
    pads = [{ axes: [0, 0, 0.05, 0], buttons: [{ pressed: false }] }];
    tracker.pollGamepad();
    assert.equal(tracker.lastActivityMs, 1000, 'resting pad');
    pads = [{ axes: [0, 0.9, 0, 0], buttons: [{ pressed: false }] }];
    tracker.pollGamepad();
    assert.equal(tracker.lastActivityMs, clock(), 'stick pushed');
  });
  it('dispose removes every listener', () => {
    const { target, tracker, advance } = setup();
    tracker.dispose();
    advance(1000);
    for (const type of [...ACTIVITY_EVENTS, 'focus', 'blur']) target.dispatchEvent(new Event(type));
    assert.equal(tracker.lastActivityMs, 1000);
    assert.equal(tracker.windowFocused, true);
    tracker.dispose(); // twice is fine
  });
  it('listeners are passive and capturing, and add/remove options match', () => {
    const added: [string, unknown][] = [];
    const removed: [string, unknown][] = [];
    const target = {
      addEventListener: (t: string, _l: unknown, o: unknown) => void added.push([t, o]),
      removeEventListener: (t: string, _l: unknown, o: unknown) => void removed.push([t, o]),
    };
    const tracker = new ActivityTracker({ target: target as never, now: () => 0, hasFocus: () => true });
    tracker.dispose();
    assert.equal(added.length, ACTIVITY_EVENTS.length + 2);
    assert.ok(added.every(([, o]) => (o as { passive?: boolean }).passive === true));
    assert.ok(added.filter(([t]) => t !== 'focus' && t !== 'blur').every(([, o]) => (o as { capture?: boolean }).capture === true));
    assert.deepEqual(removed, added);
  });
});

describe('padHasInput', () => {
  const pad = (axes: number[], buttons: { pressed: boolean; value?: number }[] = []): PadLike => ({ axes, buttons });
  it('nothing connected, or null slots, is no input', () => {
    assert.equal(padHasInput(null), false);
    assert.equal(padHasInput(undefined), false);
    assert.equal(padHasInput([null, null]), false);
  });
  it('a resting pad (stick drift under the deadzone) is no input', () => {
    assert.equal(padHasInput([pad([0.1, -0.12, 0.2, 0], [{ pressed: false, value: 0 }])]), false);
  });
  it('a pushed stick on either axis, either sign, is input', () => {
    assert.equal(padHasInput([pad([PAD_ACTIVITY_DEADZONE, 0])]), true);
    assert.equal(padHasInput([pad([0, 0, 0, -0.8])]), true);
  });
  it('a pressed button or a pulled trigger is input', () => {
    assert.equal(padHasInput([pad([0, 0], [{ pressed: false }, { pressed: true }])]), true);
    assert.equal(padHasInput([pad([0, 0], [{ pressed: false, value: 0.4 }])]), true);
  });
  it('looks at every connected pad', () => {
    assert.equal(padHasInput([null, pad([0, 0]), pad([0, 1])]), true);
  });
});
