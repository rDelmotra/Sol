import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KEY_BINDINGS, PAD_BINDINGS, type KeyBindingId, type PadAction } from '../../../bindings/bindings';
import { ALL_ROWS, KEYBOARD_ROWS, MOUSE_ROWS, entryActive, partActive, partLook } from './controls-sheet';

const PARTS = ['l1', 'r1', 'l2', 'r2', 'lstick', 'rstick', 'dpad', 'face', 'touchpad', 'select', 'start'];

describe('rows', () => {
  it('have unique labels and only known diagram parts', () => {
    const labels = ALL_ROWS.map((r) => r.label);
    assert.equal(new Set(labels).size, labels.length);
    for (const r of ALL_ROWS) for (const id of r.partIds) assert.ok(PARTS.includes(id), id);
  });
  it('drop the spike claims the engine does not honour', () => {
    const keys = ALL_ROWS.flatMap((r) => r.keycaps);
    assert.ok(!keys.includes('TAB'));
    const gear = KEYBOARD_ROWS.find((r) => r.keycaps.includes('['))!;
    assert.deepEqual(gear.partIds, ['l1', 'r1']);
    assert.ok(!MOUSE_ROWS.some((r) => r.label === 'Free-look Orbit'));
  });
});

describe('highlight both ways', () => {
  const row = KEYBOARD_ROWS.find((r) => r.keycaps.includes('['))!;
  it('a hovered diagram part lights its rows', () => {
    assert.equal(entryActive(row, 'l1'), true);
    assert.equal(entryActive(row, 'dpad'), false);
    assert.equal(entryActive(row, null), false);
  });
  it('a hovered row lights its diagram parts', () => {
    assert.equal(partActive('r1', row.partIds), true);
    assert.equal(partActive('dpad', row.partIds), false);
  });
  it('part looks: lit, dimmed, idle', () => {
    assert.equal(partLook('l1', 'l1').opacity, 1);
    assert.equal(partLook('r1', 'l1').opacity, 0.45);
    assert.equal(partLook('r1', null).opacity, 0.95);
    assert.equal(partLook('r1', []).opacity, 0.95);
  });
});

describe('rows come from the bindings table', () => {
  const caps = ALL_ROWS.flatMap((r) => r.keycaps);
  const padText = ALL_ROWS.map((r) => r.pad).join('|');

  it('every key binding shows its keycaps on a row', () => {
    for (const id of Object.keys(KEY_BINDINGS) as KeyBindingId[]) {
      for (const cap of KEY_BINDINGS[id].caps) assert.ok(caps.includes(cap), `${id}: no row shows ${cap}`);
    }
  });

  it('every pad action shows on a row (SELECT hold shares the tap row)', () => {
    for (const id of Object.keys(PAD_BINDINGS) as PadAction[]) {
      const b = PAD_BINDINGS[id];
      assert.ok(caps.includes(b.glyph) || padText.includes(b.glyph), `${id}: no row shows ${b.glyph}`);
    }
  });

  it('row text is the table text', () => {
    const land = KEYBOARD_ROWS.find((r) => r.keycaps.join() === KEY_BINDINGS.land.caps.join())!;
    assert.equal(land.label, KEY_BINDINGS.land.label);
    assert.equal(land.pad, PAD_BINDINGS.dpadDown.text);
    assert.deepEqual(land.partIds, PAD_BINDINGS.dpadDown.parts);
  });
});
