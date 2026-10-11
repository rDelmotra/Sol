/**
 * Controls-sheet data and gamepad-diagram looks, pure (no React, no store);
 * tested in controls-sheet.test.ts.
 *
 * The keyboard, meta and pad rows are GENERATED from bindings/bindings.ts (the
 * one table the engine and the HUD keys also read): keycaps, pad text and
 * diagram parts come from there, so a rebind shows up here with no edit. This
 * file only chooses which bindings share a row (ROW_SPECS) and holds the mouse
 * rows, which are three OrbitControls defaults (see engine/input/InputManager.ts)
 * and not in the table.
 */

import {
  KEY_BINDINGS,
  PAD_BINDINGS,
  type GamepadPart,
  type KeyBindingId,
  type PadAction,
} from '../../../bindings/bindings';

export type GamepadPartId = GamepadPart;

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

/** One sheet row: the bindings it shows. Text not given here comes from the table. */
interface RowSpec {
  /** Keyboard bindings; omitted for pad-only rows, whose keycaps are the pad glyphs. */
  keys?: readonly KeyBindingId[];
  /** Gamepad twins. */
  pads?: readonly PadAction[];
  /** Overrides the label (needed when a row joins several bindings). */
  label?: string;
  /** Overrides the pad column (needed when the joined text reads better as one phrase). */
  padText?: string;
}

function buildRow(spec: RowSpec): ControlEntry {
  const pads = (spec.pads ?? []).map((p) => PAD_BINDINGS[p]);
  const keys = (spec.keys ?? []).map((k) => KEY_BINDINGS[k]);
  const padOnly = spec.keys === undefined;
  const parts = [...keys.flatMap((k) => k.analogPad?.parts ?? []), ...pads.flatMap((p) => p.parts)];
  return {
    keycaps: padOnly ? pads.map((p) => p.glyph) : keys.flatMap((k) => [...k.caps]),
    label: spec.label ?? (padOnly ? pads[0].label : keys[0].label),
    pad: padOnly
      ? ''
      : spec.padText ?? keys[0].analogPad?.text ?? pads.map((p) => p.text ?? p.glyph).join(' / '),
    partIds: [...new Set(parts)],
  };
}

const KEYBOARD_SPECS: RowSpec[] = [
  { keys: ['move'] },
  { keys: ['look'] },
  { keys: ['gearDown', 'gearUp'], pads: ['gearDown', 'gearUp'], label: 'Speed gear − / +' },
  { keys: ['flyTo'], pads: ['flyTo'] },
  { keys: ['joyride'], pads: ['joyride'] },
  { keys: ['land'], pads: ['dpadDown'] },
  { keys: ['reset'] },
  { keys: ['toggleAnalysis', 'toggleFocus'], pads: ['dpadLeft', 'dpadRight'], label: 'Analysis / Focus pane', padText: 'D-PAD ◄ ►' },
  { keys: ['openAsk'], pads: ['askBar'] },
];

const META_SPECS: RowSpec[] = [
  { keys: ['toggleSheet'], pads: ['start'] },
  { keys: ['closeTop'] },
];

/** Pad-only actions: no key or mouse twin. The keycap column shows the pad control itself. */
const PAD_ONLY_SPECS: RowSpec[] = [
  { pads: ['lock'] },
  { pads: ['unfollow'] },
  { pads: ['selectTap'] },
  { pads: ['cyclePrev', 'cycleNext'], label: 'Cycle contacts' },
];

export const KEYBOARD_ROWS: ControlEntry[] = KEYBOARD_SPECS.map(buildRow);

export const META_ROWS: ControlEntry[] = META_SPECS.map(buildRow);

export const MOUSE_ROWS: ControlEntry[] = [
  { keycaps: ['LMB'], label: 'Select target', pad: '✕', partIds: ['face'] },
  { keycaps: ['DRAG'], label: 'Orbit / look', pad: 'R-STICK', partIds: ['rstick'] },
  { keycaps: ['RMB'], label: 'Pan view', pad: '', partIds: [] },
  { keycaps: ['SCROLL'], label: 'Zoom', pad: '', partIds: [] },
];

export const PAD_ONLY_ROWS: ControlEntry[] = PAD_ONLY_SPECS.map(buildRow);

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
