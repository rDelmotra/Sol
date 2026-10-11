import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BTN, CHORD_WINDOW_MS, PadMapper, SELECT_HOLD_MS, classifyKey, type PadSnapshot } from './flight-input';

function pad(down: number[] = [], extra: Partial<PadSnapshot> = {}): PadSnapshot {
  const pressed = Array.from({ length: 17 }, (_, i) => down.includes(i));
  return { pressed, values: pressed.map((p) => (p ? 1 : 0)), axes: [0, 0, 0, 0], ...extra };
}

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}, target: unknown = null) =>
  classifyKey({ key: k, metaKey: false, ctrlKey: false, altKey: false, target, ...mods });

describe('classifyKey', () => {
  it('maps action, move and look keys', () => {
    assert.deepEqual(key('G'), { action: 'flyTo' });
    assert.deepEqual(key(']'), { action: 'gearUp' });
    assert.deepEqual(key('w'), { hold: 'w', look: false });
    assert.deepEqual(key('ArrowLeft'), { hold: 'arrowleft', look: true });
    assert.equal(key('q'), null); // panels are the UI's
  });

  it('ignores modified keys (Cmd+C must not reset the camera, Cmd+R must not fly up)', () => {
    assert.equal(key('c', { metaKey: true }), null);
    assert.equal(key('r', { ctrlKey: true }), null);
    assert.equal(key('f', { altKey: true }), null);
  });

  it('ignores typing in fields', () => {
    assert.equal(key('w', {}, { tagName: 'INPUT' }), null);
    assert.equal(key('l', {}, { isContentEditable: true }), null);
  });
});

describe('PadMapper', () => {
  it('fires an action once per press, not while held', () => {
    const m = new PadMapper();
    assert.deepEqual(m.step(pad([BTN.A]), 16).actions, ['lock']);
    assert.deepEqual(m.step(pad([BTN.A]), 16).actions, []);
    m.step(pad(), 16);
    assert.deepEqual(m.step(pad([BTN.A]), 16).actions, ['lock']);
  });

  it('START does not count as "any button" (it toggles the controls sheet itself)', () => {
    const m = new PadMapper();
    assert.equal(m.step(pad([BTN.START]), 16).anyButtonPress, false);
    assert.equal(m.step(pad([BTN.START, BTN.B]), 16).anyButtonPress, true);
  });

  it('L3 then R3 inside the window is the ask-bar chord, with no solo cycle', () => {
    const m = new PadMapper();
    assert.deepEqual(m.step(pad([BTN.L3]), 16).actions, []);
    assert.deepEqual(m.step(pad([BTN.L3, BTN.R3]), 16).actions, ['askBar']);
    assert.deepEqual(m.step(pad([BTN.L3, BTN.R3]), 200).actions, []);
  });

  it('L3 alone fires cyclePrev after the window, or at once on release', () => {
    const m = new PadMapper();
    m.step(pad([BTN.L3]), 16);
    assert.deepEqual(m.step(pad([BTN.L3]), CHORD_WINDOW_MS).actions, ['cyclePrev']);
    const q = new PadMapper();
    q.step(pad([BTN.R3]), 16);
    assert.deepEqual(q.step(pad(), 16).actions, ['cycleNext']);
  });

  it('Select: tap on release; hold fires once and, if consumed, eats the tap', () => {
    const m = new PadMapper();
    m.step(pad([BTN.SELECT]), 16);
    assert.deepEqual(m.step(pad(), 16).actions, ['selectTap']);

    const h = new PadMapper();
    h.step(pad([BTN.SELECT]), 16);
    assert.deepEqual(h.step(pad([BTN.SELECT]), SELECT_HOLD_MS).actions, ['selectHold']);
    h.consumeSelect();
    assert.deepEqual(h.step(pad([BTN.SELECT]), 100).actions, []);
    assert.deepEqual(h.step(pad(), 16).actions, []);
  });

  it('maps sticks and triggers: deadzone, squared curve, stick up = up, RT forward ×2', () => {
    const m = new PadMapper();
    const values = Array(17).fill(0);
    values[BTN.RT] = 0.5;
    const f = m.step(pad([], { axes: [0.1, -1, 0.5, 0], values }), 16);
    assert.equal(f.move.x, 0);
    assert.equal(f.move.vert, 1);
    assert.equal(f.move.z, 1);
    assert.equal(f.look.x, 0.125);
  });
});
