import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyKey, PadMapper, type PadSnapshot } from '../engine/input/flight-input';
import { cockpitKeyCommand } from '../ui/cockpit/keys';
import {
  BTN,
  KEY_BINDINGS,
  PAD_BINDINGS,
  PAD_EDGE_ACTIONS,
  flightKeyAction,
  hudKeyAction,
  isDpadAction,
  isFlightPadAction,
  isHudPadAction,
  keyHint,
  padButton,
  type KeyBindingId,
  type PadAction,
} from './bindings';
import { hasModifier, isTextTarget, isTypingOrModified } from './key-guards';

const keyIds = Object.keys(KEY_BINDINGS) as KeyBindingId[];
const padIds = Object.keys(PAD_BINDINGS) as PadAction[];
const mods = { metaKey: false, ctrlKey: false, altKey: false };
const CLOSED = { controlsSheetOpen: false, askBarOpen: true, analysisPanelOpen: false, focusPanelOpen: false, scrubberMode: false };

describe('key bindings', () => {
  it('no two bindings share a key', () => {
    const seen = new Map<string, string>();
    for (const id of keyIds) {
      for (const k of KEY_BINDINGS[id].keys) {
        assert.equal(seen.get(k), undefined, `'${k}' bound to both ${seen.get(k)} and ${id}`);
        seen.set(k, id);
      }
    }
  });

  it('keys are lowercase and every key has a keycap', () => {
    for (const id of keyIds) {
      const b = KEY_BINDINGS[id];
      for (const k of b.keys) assert.equal(k, k.toLowerCase(), id);
      assert.ok(b.caps.length > 0, id);
    }
  });

  it('every flight key is handled by the engine and no HUD key is', () => {
    for (const id of keyIds) {
      const b = KEY_BINDINGS[id];
      for (const key of b.keys) {
        const c = classifyKey({ key, ...mods, target: null });
        if (b.handler === 'flight') {
          assert.ok(c, `${id} (${key}) not classified by the flight side`);
          if (id !== 'move' && id !== 'look') assert.deepEqual(c, { action: id });
          else assert.ok('hold' in c);
        } else {
          assert.equal(c, null, `${id} (${key}) leaked into flight`);
        }
      }
    }
  });

  it('every HUD key is handled by the cockpit key map and no flight key is', () => {
    for (const id of keyIds) {
      const b = KEY_BINDINGS[id];
      for (const key of b.keys) {
        const cmd = cockpitKeyCommand({ key, ...mods, target: null }, CLOSED);
        if (b.handler === 'hud') {
          assert.equal(hudKeyAction(key), id);
          assert.ok(cmd, `${id} (${key}) gives no cockpit command`);
        } else {
          assert.equal(cmd, null, `${id} (${key}) leaked into the HUD`);
        }
      }
    }
  });

  it('lookup is case-insensitive', () => {
    assert.equal(flightKeyAction('G'), 'flyTo');
    assert.equal(hudKeyAction('Q'), 'toggleAnalysis');
    assert.equal(hudKeyAction('Escape'), 'closeTop');
    assert.equal(flightKeyAction('q'), undefined);
  });

  it('hints', () => {
    assert.equal(keyHint('flyTo'), '[G]');
    assert.equal(keyHint('joyride'), '[J]');
  });
});

describe('pad bindings', () => {
  it('every pad action fires from its own trigger, once', () => {
    for (const id of padIds) {
      const t = PAD_BINDINGS[id].trigger;
      const buttons = t.kind === 'chord' ? [...t.buttons] : [t.button];
      const snap = (down: number[]): PadSnapshot => ({
        pressed: Array.from({ length: 17 }, (_, i) => down.includes(i)),
        values: Array(17).fill(0),
        axes: [0, 0, 0, 0],
      });
      const m = new PadMapper();
      const fired: PadAction[] = [];
      // press, hold past every timing window, release
      fired.push(...m.step(snap([]), 16).actions);
      fired.push(...m.step(snap(buttons), 16).actions);
      fired.push(...m.step(snap(buttons), 1000).actions);
      fired.push(...m.step(snap([]), 16).actions);
      assert.ok(fired.includes(id), `${id} never fired from its trigger`);
    }
  });

  it('every pad action has exactly one side', () => {
    for (const id of padIds) {
      const sides = [isDpadAction(id), isFlightPadAction(id), isHudPadAction(id)].filter(Boolean);
      assert.equal(sides.length, 1, id);
    }
  });

  it('edge actions keep the report order the engine always used', () => {
    assert.deepEqual(
      PAD_EDGE_ACTIONS.map(([, a]) => a),
      ['lock', 'unfollow', 'flyTo', 'joyride', 'gearDown', 'gearUp', 'dpadLeft', 'dpadRight', 'dpadDown', 'start'],
    );
  });

  it('the ask-bar chord is exactly L3 + R3, the two solo cycle buttons', () => {
    const chord = PAD_BINDINGS.askBar.trigger;
    assert.equal(chord.kind, 'chord');
    if (chord.kind === 'chord') assert.deepEqual([...chord.buttons], [padButton('cyclePrev'), padButton('cycleNext')]);
    assert.equal(padButton('cyclePrev'), BTN.L3);
    assert.equal(padButton('selectTap'), padButton('selectHold'));
  });
});

describe('isTypingOrModified', () => {
  it('flags modifiers and text fields, nothing else', () => {
    assert.equal(isTypingOrModified({ ...mods, target: null }), false);
    assert.equal(isTypingOrModified({ ...mods, target: { tagName: 'BODY' } }), false);
    assert.equal(isTypingOrModified({ ...mods, metaKey: true, target: null }), true);
    assert.equal(isTypingOrModified({ ...mods, target: { tagName: 'TEXTAREA' } }), true);
    assert.equal(isTypingOrModified({ ...mods, target: { isContentEditable: true } }), true);
    assert.equal(hasModifier({ ...mods, altKey: true }), true);
    assert.equal(isTextTarget(undefined), false);
  });
});
