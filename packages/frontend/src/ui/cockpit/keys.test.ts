import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cockpitKeyCommand, type KeyLike, type OpenSurfaces } from './keys';

const CLOSED: OpenSurfaces = {
  controlsSheetOpen: false,
  askBarOpen: false,
  analysisPanelOpen: false,
  focusPanelOpen: false,
  scrubberMode: false,
};
const body = { tagName: 'BODY', getAttribute: () => null };
const key = (k: string, over: Partial<KeyLike> = {}): KeyLike => ({
  key: k, metaKey: false, ctrlKey: false, altKey: false, target: body, ...over,
});

describe('cockpitKeyCommand', () => {
  it('maps Q, E, ?, / and Space', () => {
    assert.equal(cockpitKeyCommand(key('q'), CLOSED), 'toggleAnalysis');
    assert.equal(cockpitKeyCommand(key('E'), CLOSED), 'toggleFocus');
    assert.equal(cockpitKeyCommand(key('?'), CLOSED), 'toggleSheet');
    assert.equal(cockpitKeyCommand(key('/'), CLOSED), 'toggleSheet');
    assert.equal(cockpitKeyCommand(key(' '), CLOSED), 'openAsk');
  });

  it('ignores Cmd / Ctrl / Alt chords, text fields, Tab and key repeat', () => {
    assert.equal(cockpitKeyCommand(key('q', { metaKey: true }), CLOSED), null);
    assert.equal(cockpitKeyCommand(key('e', { ctrlKey: true }), CLOSED), null);
    assert.equal(cockpitKeyCommand(key(' ', { altKey: true }), CLOSED), null);
    assert.equal(cockpitKeyCommand(key('q', { target: { tagName: 'INPUT' } }), CLOSED), null);
    assert.equal(cockpitKeyCommand(key('Escape', { target: { tagName: 'TEXTAREA' } }), { ...CLOSED, askBarOpen: true }), null);
    assert.equal(cockpitKeyCommand(key('q', { target: { tagName: 'DIV', isContentEditable: true } }), CLOSED), null);
    assert.equal(cockpitKeyCommand(key('Tab'), CLOSED), null);
    assert.equal(cockpitKeyCommand(key('q', { repeat: true }), CLOSED), null);
  });

  it('Space never steals a focused control', () => {
    assert.equal(cockpitKeyCommand(key(' ', { target: { tagName: 'BUTTON' } }), CLOSED), null);
    assert.equal(cockpitKeyCommand(key(' ', { target: { tagName: 'A' } }), CLOSED), null);
    const roleButton = { tagName: 'DIV', getAttribute: (n: string) => (n === 'role' ? 'button' : null) };
    assert.equal(cockpitKeyCommand(key(' ', { target: roleButton }), CLOSED), null);
    assert.equal(cockpitKeyCommand(key(' ', { defaultPrevented: true }), CLOSED), null);
  });

  it('Esc closes one surface, sheet first, then ask bar, panes, scrubber', () => {
    const all: OpenSurfaces = {
      controlsSheetOpen: true, askBarOpen: true, analysisPanelOpen: true, focusPanelOpen: false, scrubberMode: true,
    };
    assert.equal(cockpitKeyCommand(key('Escape'), all), 'closeSheet');
    assert.equal(cockpitKeyCommand(key('Escape'), { ...all, controlsSheetOpen: false }), 'closeAsk');
    assert.equal(cockpitKeyCommand(key('Escape'), { ...all, controlsSheetOpen: false, askBarOpen: false }), 'closePanels');
    assert.equal(
      cockpitKeyCommand(key('Escape'), { ...CLOSED, focusPanelOpen: true, scrubberMode: true }),
      'closePanels',
    );
    assert.equal(cockpitKeyCommand(key('Escape'), { ...CLOSED, scrubberMode: true }), 'closeScrubber');
    assert.equal(cockpitKeyCommand(key('Escape'), CLOSED), null);
  });

  it('Esc still works with focus on a button', () => {
    assert.equal(
      cockpitKeyCommand(key('Escape', { target: { tagName: 'BUTTON' } }), { ...CLOSED, askBarOpen: true }),
      'closeAsk',
    );
  });
});
