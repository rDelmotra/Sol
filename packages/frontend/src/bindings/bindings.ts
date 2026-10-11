/**
 * Every keyboard key, gamepad button and chord, declared once. Zone `bindings/`
 * is a leaf (imports nothing from the app) so the engine and the UI can both
 * read it; tests/architecture.test.ts enforces that.
 *
 * Who derives from this table:
 *   engine/input/flight-input.ts    key lookup, move/look key sets, pad edge table, chord/Select buttons
 *   ui/cockpit/keys.ts              Q / E / Space / ? / Esc
 *   ui/cockpit/controls/            the controls-sheet rows and diagram parts
 *   ui/cockpit/hud/EdgeArc.tsx, panes/ActionsPane.tsx   hint glyphs
 * Who ACTS on each action (the `handler` field):
 *   'flight'  engine/controllers/FlyController.ts (camera, gears, fly-to, land)
 *   'hud'     engine/input/pad-commands.ts (pad) or ui/cockpit/useCockpitKeys.ts (keys)
 * Mouse bindings are not here: they are three.js OrbitControls defaults.
 */

export type Handler = 'flight' | 'hud';

/** Parts of the gamepad diagram a binding lights. */
export type GamepadPart =
  | 'l1' | 'r1' | 'l2' | 'r2' | 'lstick' | 'rstick' | 'dpad' | 'face' | 'touchpad' | 'select' | 'start';

/** Standard-mapping button indices. */
export const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, L3: 10, R3: 11,
  DPAD_U: 12, DPAD_D: 13, DPAD_L: 14, DPAD_R: 15,
} as const;

// ── Keyboard ─────────────────────────────────────────────────────────────────

/** Press-once flight keys (FlyController). */
export type FlightKeyAction = 'gearDown' | 'gearUp' | 'flyTo' | 'joyride' | 'reset' | 'land';
/** Held flight keys: move (WASD RF) and look (arrows). */
export type HoldKeyGroup = 'move' | 'look';
/** HUD keys (useCockpitKeys). */
export type HudKeyAction = 'toggleAnalysis' | 'toggleFocus' | 'openAsk' | 'toggleSheet' | 'closeTop';
export type KeyBindingId = FlightKeyAction | HoldKeyGroup | HudKeyAction;

export interface KeyBinding {
  handler: Handler;
  /** Row label on the controls sheet. */
  label: string;
  /** KeyboardEvent.key values, lowercase; matching lowercases the event key. */
  keys: readonly string[];
  /** Keycaps as shown to the user. */
  caps: readonly string[];
  /** Analog gamepad twin of a held key group (no button): text and diagram parts. */
  analogPad?: { text: string; parts: readonly GamepadPart[] };
}

type KeyTable = { [K in KeyBindingId]: KeyBinding & { handler: K extends HudKeyAction ? 'hud' : 'flight' } };

export const KEY_BINDINGS: KeyTable = {
  move: {
    handler: 'flight', label: 'Move / strafe / up-down',
    keys: ['w', 'a', 's', 'd', 'r', 'f'], caps: ['W', 'A', 'S', 'D', 'R', 'F'],
    analogPad: { text: 'L-STICK · L2 R2', parts: ['lstick', 'l2', 'r2'] },
  },
  look: {
    handler: 'flight', label: 'Look around',
    keys: ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'], caps: ['↑', '↓', '←', '→'],
    analogPad: { text: 'R-STICK', parts: ['rstick'] },
  },
  gearDown: { handler: 'flight', label: 'Speed gear −', keys: ['['], caps: ['['] },
  gearUp: { handler: 'flight', label: 'Speed gear +', keys: [']'], caps: [']'] },
  flyTo: { handler: 'flight', label: 'Fly to selected', keys: ['g'], caps: ['G'] },
  joyride: { handler: 'flight', label: 'Joyride selected', keys: ['j'], caps: ['J'] },
  land: { handler: 'flight', label: 'Land / take off', keys: ['l'], caps: ['L'] },
  reset: { handler: 'flight', label: 'Reset camera', keys: ['c'], caps: ['C'] },
  toggleAnalysis: { handler: 'hud', label: 'Analysis pane', keys: ['q'], caps: ['Q'] },
  toggleFocus: { handler: 'hud', label: 'Focus pane', keys: ['e'], caps: ['E'] },
  openAsk: { handler: 'hud', label: 'Ask catalog', keys: [' '], caps: ['SPACE'] },
  toggleSheet: { handler: 'hud', label: 'Toggle controls', keys: ['?', '/'], caps: ['?'] },
  closeTop: { handler: 'hud', label: 'Close top surface', keys: ['escape'], caps: ['ESC'] },
};

const KEY_IDS = Object.keys(KEY_BINDINGS) as KeyBindingId[];

function keyLookup<T extends KeyBindingId>(ids: readonly T[]): ReadonlyMap<string, T> {
  const m = new Map<string, T>();
  for (const id of ids) for (const k of KEY_BINDINGS[id].keys) m.set(k, id);
  return m;
}

const FLIGHT_KEY_IDS = KEY_IDS.filter((id): id is FlightKeyAction => id !== 'move' && id !== 'look' && KEY_BINDINGS[id].handler === 'flight');
const HUD_KEY_IDS = KEY_IDS.filter((id): id is HudKeyAction => KEY_BINDINGS[id].handler === 'hud');
const FLIGHT_KEYS = keyLookup(FLIGHT_KEY_IDS);
const HUD_KEYS = keyLookup(HUD_KEY_IDS);

/** Lowercased key → the flight action it fires, or undefined. */
export function flightKeyAction(key: string): FlightKeyAction | undefined {
  return FLIGHT_KEYS.get(key.toLowerCase());
}

/** Lowercased key → the HUD key action it triggers, or undefined. */
export function hudKeyAction(key: string): HudKeyAction | undefined {
  return HUD_KEYS.get(key.toLowerCase());
}

export const MOVE_KEYS: ReadonlySet<string> = new Set(KEY_BINDINGS.move.keys);
export const LOOK_KEYS: ReadonlySet<string> = new Set(KEY_BINDINGS.look.keys);

/** Hint text such as "[G]" for a key binding's first keycap. */
export function keyHint(id: KeyBindingId): string {
  return `[${KEY_BINDINGS[id].caps[0]}]`;
}

// ── Gamepad ──────────────────────────────────────────────────────────────────

/** Buttons whose press fires the action once on the frame it goes down. */
export type PadTrigger =
  | { kind: 'edge'; button: number }
  /** L3 / R3 alone: fires after the chord window (or on release) unless the other stick joins. */
  | { kind: 'solo'; button: number }
  | { kind: 'chord'; buttons: readonly [number, number] }
  /** Fires on release, unless the hold fired first. */
  | { kind: 'tap'; button: number }
  /** Fires once when held long enough. */
  | { kind: 'hold'; button: number };

/** Acted on by FlyController. */
export type FlightPadAction = 'unfollow' | 'flyTo' | 'joyride' | 'gearDown' | 'gearUp';
/** Acted on by PadCommandRouter. */
export type HudPadAction = 'lock' | 'start' | 'cyclePrev' | 'cycleNext' | 'askBar' | 'selectHold' | 'selectTap';
/** D-pad edges: meaning depends on scrub mode, so GamepadScrubDriver acts on them after the rest. */
export type DpadAction = 'dpadLeft' | 'dpadRight' | 'dpadDown';
export type PadAction = FlightPadAction | HudPadAction | DpadAction;

export interface PadBinding {
  handler: Handler;
  label: string;
  trigger: PadTrigger;
  /** Short mark: the hint on the HUD edge arcs, and the keycap of pad-only sheet rows. */
  glyph: string;
  /** Pad column text on the sheet, when longer than the glyph. */
  text?: string;
  parts: readonly GamepadPart[];
}

type PadTable = { [K in PadAction]: PadBinding & { handler: K extends 'unfollow' | 'flyTo' | 'joyride' | 'gearDown' | 'gearUp' | 'dpadDown' ? 'flight' : 'hud' } };

/**
 * Edge buttons come first, in the order PadMapper reports them within a frame
 * (lock … start); chord, solo and Select actions follow.
 */
export const PAD_BINDINGS: PadTable = {
  lock: { handler: 'hud', label: 'Lock candidate', trigger: { kind: 'edge', button: BTN.A }, glyph: '✕', parts: ['face'] },
  unfollow: { handler: 'flight', label: 'Release follow', trigger: { kind: 'edge', button: BTN.B }, glyph: '◯', parts: ['face'] },
  flyTo: { handler: 'flight', label: 'Fly to selected', trigger: { kind: 'edge', button: BTN.X }, glyph: '□', parts: ['face'] },
  joyride: { handler: 'flight', label: 'Joyride selected', trigger: { kind: 'edge', button: BTN.Y }, glyph: '△', parts: ['face'] },
  gearDown: { handler: 'flight', label: 'Speed gear −', trigger: { kind: 'edge', button: BTN.LB }, glyph: 'L1', parts: ['l1'] },
  gearUp: { handler: 'flight', label: 'Speed gear +', trigger: { kind: 'edge', button: BTN.RB }, glyph: 'R1', parts: ['r1'] },
  dpadLeft: { handler: 'hud', label: 'Analysis pane (scrubber: previous field)', trigger: { kind: 'edge', button: BTN.DPAD_L }, glyph: '◄', text: 'D-PAD ◄', parts: ['dpad'] },
  dpadRight: { handler: 'hud', label: 'Focus pane (scrubber: next field)', trigger: { kind: 'edge', button: BTN.DPAD_R }, glyph: '►', text: 'D-PAD ►', parts: ['dpad'] },
  dpadDown: { handler: 'flight', label: 'Land / take off', trigger: { kind: 'edge', button: BTN.DPAD_D }, glyph: '▼', text: 'D-PAD ▼', parts: ['dpad'] },
  start: { handler: 'hud', label: 'Toggle controls', trigger: { kind: 'edge', button: BTN.START }, glyph: 'START', parts: ['start'] },
  askBar: { handler: 'hud', label: 'Ask catalog', trigger: { kind: 'chord', buttons: [BTN.L3, BTN.R3] }, glyph: 'L3 + R3', parts: ['lstick', 'rstick'] },
  cyclePrev: { handler: 'hud', label: 'Previous contact', trigger: { kind: 'solo', button: BTN.L3 }, glyph: 'L3', parts: ['lstick'] },
  cycleNext: { handler: 'hud', label: 'Next contact', trigger: { kind: 'solo', button: BTN.R3 }, glyph: 'R3', parts: ['rstick'] },
  selectHold: { handler: 'hud', label: 'Time console (hold closes)', trigger: { kind: 'hold', button: BTN.SELECT }, glyph: 'SELECT', parts: ['select'] },
  selectTap: { handler: 'hud', label: 'Time console (tap)', trigger: { kind: 'tap', button: BTN.SELECT }, glyph: 'SELECT', parts: ['select'] },
};

const PAD_IDS = Object.keys(PAD_BINDINGS) as PadAction[];

/** Edge-triggered pad actions in report order (PadMapper's EDGE table). */
export const PAD_EDGE_ACTIONS: readonly (readonly [number, PadAction])[] = PAD_IDS.flatMap((id) => {
  const t = PAD_BINDINGS[id].trigger;
  return t.kind === 'edge' ? [[t.button, id] as const] : [];
});

/** Button of a single-button trigger (edge / solo / tap / hold). */
export function padButton(id: PadAction): number {
  const t = PAD_BINDINGS[id].trigger;
  if (t.kind === 'chord') throw new Error(`pad action '${id}' is a chord, not a single button`);
  return t.button;
}

export function isDpadAction(a: PadAction): a is DpadAction {
  return a === 'dpadLeft' || a === 'dpadRight' || a === 'dpadDown';
}

export function isFlightPadAction(a: PadAction): a is FlightPadAction {
  return PAD_BINDINGS[a].handler === 'flight' && !isDpadAction(a);
}

export function isHudPadAction(a: PadAction): a is HudPadAction {
  return PAD_BINDINGS[a].handler === 'hud' && !isDpadAction(a);
}
