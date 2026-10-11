import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
