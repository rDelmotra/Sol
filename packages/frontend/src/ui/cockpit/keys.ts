/**
 * Cockpit HUD keyboard map, as a pure decision: keydown + open surfaces → one
 * command. useCockpitKeys.ts applies it. Flight keys (WASD, [ ], G, J, C, L)
 * belong to the engine's FlyController and are not handled here.
 *
 *   Q / E      toggle the ANALYSIS / FOCUS panes
 *   Space      open the ask bar, unless focus is on a control (a button,
 *              link or field must keep its own Space)
 *   ? or /     toggle the controls sheet
 *   Esc        closes ONE thing: controls sheet, else ask bar, else panes,
 *              else the time scrubber (time stays where it was put)
 *
 * Never handled: keys with Cmd / Ctrl / Alt (browser and OS shortcuts), keys
 * typed into a text field, and Tab (keyboard focus must keep working).
 */

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
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const CONTROL_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);

function isTextField(t: TargetLike | null): boolean {
  return !!t && (TEXT_TAGS.has(t.tagName ?? '') || t.isContentEditable === true);
}

/** A focused control that Space would activate. */
function isControl(t: TargetLike | null): boolean {
  if (!t) return false;
  if (CONTROL_TAGS.has(t.tagName ?? '')) return true;
  const role = t.getAttribute?.('role');
  return role === 'button' || role === 'link' || role === 'checkbox' || role === 'switch';
}

export function cockpitKeyCommand(e: KeyLike, s: OpenSurfaces): CockpitKeyCommand | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = (e.target ?? null) as TargetLike | null;
  if (isTextField(t)) return null;
  const k = e.key;

  if (k === 'Escape') {
    if (s.controlsSheetOpen) return 'closeSheet';
    if (s.askBarOpen) return 'closeAsk';
    if (s.analysisPanelOpen || s.focusPanelOpen) return 'closePanels';
    if (s.scrubberMode) return 'closeScrubber';
    return null;
  }
  if (e.repeat) return null; // holding a toggle key must not flicker it
  if (k === '?' || k === '/') return 'toggleSheet';
  if (k === 'q' || k === 'Q') return 'toggleAnalysis';
  if (k === 'e' || k === 'E') return 'toggleFocus';
  if (k === ' ') {
    if (e.defaultPrevented || isControl(t)) return null;
    return 'openAsk';
  }
  return null;
}
