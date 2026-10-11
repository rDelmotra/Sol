/**
 * Cockpit HUD keyboard map, as a pure decision: keydown + open surfaces → one
 * command. useCockpitKeys.ts applies it. Flight keys (WASD, [ ], G, J, C, L)
 * belong to the engine's FlyController and are not handled here. Which key is
 * which is declared in bindings/bindings.ts (KEY_BINDINGS); this file only
 * decides what each HUD key does given what is open:
 *
 *   toggleAnalysis / toggleFocus   the ANALYSIS / FOCUS panes
 *   openAsk                        the ask bar, unless focus is on a control
 *                                  (a button, link or field keeps its own Space)
 *   toggleSheet                    the controls sheet
 *   closeTop (Esc)                 closes ONE thing: controls sheet, else ask
 *                                  bar, else panes, else the time scrubber
 *                                  (time stays where it was put)
 *
 * Never handled: keys with Cmd / Ctrl / Alt (browser and OS shortcuts), keys
 * typed into a text field, and Tab (keyboard focus must keep working).
 */

import { hudKeyAction } from '../../bindings/bindings';
import { isTypingOrModified } from '../../bindings/key-guards';

export type CockpitKeyCommand =
  | 'toggleAnalysis'
  | 'toggleFocus'
  | 'openAsk'
  | 'toggleSheet'
  | 'closeSheet'
  | 'closeAsk'
  | 'closePanels'
  | 'closeScrubber';

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target: unknown;
}

export interface OpenSurfaces {
  controlsSheetOpen: boolean;
  askBarOpen: boolean;
  analysisPanelOpen: boolean;
  focusPanelOpen: boolean;
  scrubberMode: boolean;
}

interface TargetLike {
  tagName?: string;
  getAttribute?: (name: string) => string | null;
}

const CONTROL_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);

/** A focused control that Space would activate. */
function isControl(t: TargetLike | null): boolean {
  if (!t) return false;
  if (CONTROL_TAGS.has(t.tagName ?? '')) return true;
  const role = t.getAttribute?.('role');
  return role === 'button' || role === 'link' || role === 'checkbox' || role === 'switch';
}

export function cockpitKeyCommand(e: KeyLike, s: OpenSurfaces): CockpitKeyCommand | null {
  if (isTypingOrModified(e)) return null;
  const t = (e.target ?? null) as TargetLike | null;
  const action = hudKeyAction(e.key);
  if (!action) return null;

  if (action === 'closeTop') {
    if (s.controlsSheetOpen) return 'closeSheet';
    if (s.askBarOpen) return 'closeAsk';
    if (s.analysisPanelOpen || s.focusPanelOpen) return 'closePanels';
    if (s.scrubberMode) return 'closeScrubber';
    return null;
  }
  if (e.repeat) return null; // holding a toggle key must not flicker it
  if (action === 'openAsk' && (e.defaultPrevented || isControl(t))) return null;
  return action;
}
