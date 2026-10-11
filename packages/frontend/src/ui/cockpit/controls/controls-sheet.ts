/**
 * Controls-sheet data and gamepad-diagram looks, pure (no React, no store);
 * tested in controls-sheet.test.ts.
 *
 * The rows list the REAL bindings. Source of truth (ui/ may not import the
 * engine, so keep these in step by hand):
 *   keyboard   engine/input/flight-input.ts  KEY_ACTIONS, MOVE_KEYS, LOOK_KEYS
 *   pad        engine/input/flight-input.ts  EDGE_ACTIONS, PadMapper.step
 *              engine/controllers/FlyController.ts  applyPad / applyDpad
 *   panes/ask  ui/cockpit/keys.ts
 *   mouse      three OrbitControls defaults + engine/input/InputManager.ts
 * The spike's table was wrong (Tab cycles nothing; D-pad does not cycle
 * contacts; L1/R1 are gears, not panes; there is no throttle R/F).
 */

export type GamepadPartId =
  | 'l1' | 'r1' | 'l2' | 'r2' | 'lstick' | 'rstick' | 'dpad' | 'face' | 'touchpad' | 'select' | 'start';

/** What the diagram can be told to light: one part, several, or none. */
export type ActivePart = GamepadPartId | readonly GamepadPartId[] | null;

export interface ControlEntry {
  keycaps: string[];
  label: string;
  /** The gamepad control, in the diagram's own labels. */
  pad: string;
  /** Diagram parts lit with this row (and lighting it back). */
  partIds: GamepadPartId[];
}

export const KEYBOARD_ROWS: ControlEntry[] = [
  { keycaps: ['W', 'A', 'S', 'D', 'R', 'F'], label: 'Move / strafe / up-down', pad: 'L-STICK · L2 R2', partIds: ['lstick', 'l2', 'r2'] },
  { keycaps: ['↑', '↓', '←', '→'], label: 'Look around', pad: 'R-STICK', partIds: ['rstick'] },
  { keycaps: ['[', ']'], label: 'Speed gear − / +', pad: 'L1 / R1', partIds: ['l1', 'r1'] },
  { keycaps: ['G'], label: 'Fly to selected', pad: '□', partIds: ['face'] },
  { keycaps: ['J'], label: 'Joyride selected', pad: '△', partIds: ['face'] },
  { keycaps: ['L'], label: 'Land / take off', pad: 'D-PAD ▼', partIds: ['dpad'] },
  { keycaps: ['C'], label: 'Reset camera', pad: '', partIds: [] },
  { keycaps: ['Q', 'E'], label: 'Analysis / Focus pane', pad: 'D-PAD ◄ ►', partIds: ['dpad'] },
  { keycaps: ['SPACE'], label: 'Ask catalog', pad: 'L3 + R3', partIds: ['lstick', 'rstick'] },
];

export const META_ROWS: ControlEntry[] = [
  { keycaps: ['?'], label: 'Toggle controls', pad: 'START', partIds: ['start'] },
  { keycaps: ['ESC'], label: 'Close top surface', pad: '', partIds: [] },
];

export const MOUSE_ROWS: ControlEntry[] = [
  { keycaps: ['LMB'], label: 'Select target', pad: '✕', partIds: ['face'] },
  { keycaps: ['DRAG'], label: 'Orbit / look', pad: 'R-STICK', partIds: ['rstick'] },
  { keycaps: ['RMB'], label: 'Pan view', pad: '', partIds: [] },
  { keycaps: ['SCROLL'], label: 'Zoom', pad: '', partIds: [] },
];

/** Pad-only actions: no key or mouse twin. The keycap column shows the pad control itself. */
export const PAD_ONLY_ROWS: ControlEntry[] = [
  { keycaps: ['✕'], label: 'Lock candidate', pad: '', partIds: ['face'] },
  { keycaps: ['◯'], label: 'Release follow', pad: '', partIds: ['face'] },
  { keycaps: ['SELECT'], label: 'Time console (tap)', pad: '', partIds: ['select'] },
  { keycaps: ['L3', 'R3'], label: 'Cycle contacts', pad: '', partIds: ['lstick', 'rstick'] },
];

export const ALL_ROWS: ControlEntry[] = [...KEYBOARD_ROWS, ...META_ROWS, ...MOUSE_ROWS, ...PAD_ONLY_ROWS];

function asList(a: ActivePart): readonly GamepadPartId[] {
  return a === null ? [] : typeof a === 'string' ? [a] : a;
}

/** Whether a row lights for the current hover (a row's parts, or one diagram part). */
export function entryActive(entry: ControlEntry, hover: ActivePart): boolean {
  const ids = asList(hover);
  return entry.partIds.some((id) => ids.includes(id));
}

/** Whether a diagram part is the lit one. */
export function partActive(id: GamepadPartId, active: ActivePart): boolean {
  return asList(active).includes(id);
}

export interface PartLook {
  opacity: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  filter: string;
  textColor: string;
  fontWeight: string;
}

/** Look of one diagram part: lit, dimmed (something else is lit), or idle. */
export function partLook(id: GamepadPartId, active: ActivePart): PartLook {
  if (partActive(id, active)) {
    return {
      opacity: 1,
      fill: 'oklch(0.28 0.06 240 / 0.85)',
      stroke: 'var(--hud-arc, #ffffff)',
      strokeWidth: 2.5,
      filter: 'drop-shadow(0 0 8px var(--hud-arc-glow, rgba(255,255,255,0.7)))',
      textColor: 'var(--hud-text, #ffffff)',
      fontWeight: 'bold',
    };
  }
  if (asList(active).length > 0) {
    return {
      opacity: 0.45,
      fill: 'var(--hud-glass, oklch(0.14 0.02 250 / 0.55))',
      stroke: 'var(--hud-arc-dim, rgba(255, 255, 255, 0.35))',
      strokeWidth: 2,
      filter: 'none',
      textColor: 'var(--hud-text-dim, rgba(255, 255, 255, 0.45))',
      fontWeight: 'normal',
    };
  }
  return {
    opacity: 0.95,
    fill: 'var(--hud-glass-panel, oklch(0.11 0.02 250 / 0.82))',
    stroke: 'var(--hud-arc, rgba(255, 255, 255, 0.75))',
    strokeWidth: 2,
    filter: 'none',
    textColor: 'var(--hud-text, #ffffff)',
    fontWeight: '600',
  };
}
