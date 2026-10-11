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
 *   closeTop (Esc)                 closes ONE thing: controls sheet, else
 *                                  location popover, else ask bar, else panes,
 *                                  else the time scrubber (time stays where
 *                                  it was put)
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
  | 'closeLocation'
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
  locationPopoverOpen: boolean;
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
    if (s.locationPopoverOpen) return 'closeLocation';
    if (s.askBarOpen) return 'closeAsk';
    if (s.analysisPanelOpen || s.focusPanelOpen) return 'closePanels';
    if (s.scrubberMode) return 'closeScrubber';
    return null;
  }
  if (e.repeat) return null; // holding a toggle key must not flicker it
  if (action === 'openAsk' && (e.defaultPrevented || isControl(t))) return null;
  return action;
}

/** The store calls a command can make. A narrow slice so applyCockpitKeyCommand is testable with a fake. */
export interface CockpitKeyActions {
  toggleAnalysisPanel(): void;
  toggleFocusPanel(): void;
  setAskBarOpen(open: boolean): void;
  toggleControlsSheet(): void;
  setControlsSheetOpen(open: boolean): void;
  setLocationPopoverOpen(open: boolean): void;
  closePanels(): void;
  setScrubberMode(on: boolean): void;
}

/** Apply a command. Returns true when the browser's default (page scroll, a typed space or slash) must be prevented. */
export function applyCockpitKeyCommand(cmd: CockpitKeyCommand, a: CockpitKeyActions): boolean {
  switch (cmd) {
    case 'toggleAnalysis': a.toggleAnalysisPanel(); return false;
    case 'toggleFocus': a.toggleFocusPanel(); return false;
    case 'openAsk': a.setAskBarOpen(true); return true;
    case 'toggleSheet': a.toggleControlsSheet(); return true;
    case 'closeSheet': a.setControlsSheetOpen(false); return false;
    case 'closeLocation': a.setLocationPopoverOpen(false); return false;
    case 'closeAsk': a.setAskBarOpen(false); return false;
    case 'closePanels': a.closePanels(); return false;
    case 'closeScrubber': a.setScrubberMode(false); return false;
    default: {
      const _never: never = cmd;
      return _never;
    }
  }
}
