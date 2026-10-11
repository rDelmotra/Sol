import { FLIGHT, curve, triggerLinear, type MoveIntent } from '../controllers/flight-model';

/**
 * Keyboard + gamepad → named flight actions. No camera, no store: FlyController
 * decides what each action does. The pad side is a pure per-frame mapper over a
 * plain snapshot, so edge detection, the L3+R3 chord and the Select tap/hold are
 * unit-tested without a real Gamepad.
 */

// ── Keyboard ─────────────────────────────────────────────────────────────────

export type KeyAction = 'gearDown' | 'gearUp' | 'flyTo' | 'joyride' | 'reset' | 'land';

const KEY_ACTIONS: Record<string, KeyAction> = {
  '[': 'gearDown',
  ']': 'gearUp',
  g: 'flyTo',
  j: 'joyride',
  c: 'reset',
  l: 'land',
};
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'r', 'f']);
const LOOK_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

/** What a keydown means for flight: an action, a held move/look key, or nothing. */
export function classifyKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
}): { action: KeyAction } | { hold: string; look: boolean } | null {
  // Browser/OS shortcuts (Cmd+C, Ctrl+R, Alt+…) are never flight input.
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
    return null;
  }
  const k = e.key.toLowerCase();
  const action = KEY_ACTIONS[k];
  if (action) return { action };
  if (MOVE_KEYS.has(k)) return { hold: k, look: false };
  if (LOOK_KEYS.has(k)) return { hold: k, look: true };
  return null;
}

/**
 * Window keyboard listener. Held move/look keys live in `held`; action keys fire
 * `onAction` once per press (key repeat ignored). Held keys are dropped on window
 * blur, on the tab hiding, and when a modifier goes down — macOS sends no keyup
 * for keys released while Cmd is held, which used to leave the camera flying.
 */
export class KeyboardFlightInput {
  readonly held = new Set<string>();

  constructor(private readonly onAction: (a: KeyAction) => void) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clear);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Digital move intent from held keys (x strafe, z forward, vert up). */
  moveIntent(): MoveIntent {
    const h = this.held;
    return {
      x: (h.has('d') ? 1 : 0) - (h.has('a') ? 1 : 0),
      z: (h.has('w') ? 1 : 0) - (h.has('s') ? 1 : 0),
      vert: (h.has('r') ? 1 : 0) - (h.has('f') ? 1 : 0),
    };
  }

  /** Arrow keys as a digital right stick (right/down +). */
  look(): { x: number; y: number } {
    const h = this.held;
    return {
      x: (h.has('arrowright') ? 1 : 0) - (h.has('arrowleft') ? 1 : 0),
      y: (h.has('arrowdown') ? 1 : 0) - (h.has('arrowup') ? 1 : 0),
    };
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      this.clear();
      return;
    }
    const c = classifyKey(e);
    if (!c) return;
    if ('action' in c) {
      if (!e.repeat) this.onAction(c.action);
      return;
    }
    if (c.look) e.preventDefault(); // arrows would scroll the page
    this.held.add(c.hold);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') {
      this.clear();
      return;
    }
    this.held.delete(e.key.toLowerCase());
  };

  private onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.clear();
  };

  clear = (): void => {
    this.held.clear();
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.clear);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.held.clear();
  }
}

// ── Gamepad ──────────────────────────────────────────────────────────────────

/** Standard-mapping button indices. */
export const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, L3: 10, R3: 11,
  DPAD_U: 12, DPAD_D: 13, DPAD_L: 14, DPAD_R: 15,
} as const;

/** L3 or R3 alone waits this long for the other stick before firing solo. */
export const CHORD_WINDOW_MS = 120;
/** Holding Select this long (while scrubbing) closes the scrubber. */
export const SELECT_HOLD_MS = 550;

export type PadAction =
  | 'lock' | 'unfollow' | 'flyTo' | 'joyride' | 'gearDown' | 'gearUp'
  | 'dpadLeft' | 'dpadRight' | 'dpadDown' | 'start'
  | 'cyclePrev' | 'cycleNext' | 'askBar'
  | 'selectHold' | 'selectTap';

/** One frame of pad state, decoupled from the browser Gamepad object. */
export interface PadSnapshot {
  pressed: boolean[];
  values: number[];
  axes: number[];
}

export interface PadFrame {
  /** Edge-triggered actions this frame, in a stable order. */
  actions: PadAction[];
  /** A fresh press of any button except START (closes the controls sheet). */
  anyButtonPress: boolean;
  /** Analog move intent: left stick strafe/vertical, triggers forward/back (×2 dash). */
  move: MoveIntent;
  /** Right stick look, curved and scaled (right/down +). */
  look: { x: number; y: number };
  /** D-pad ▲ = +1, ▼ = -1, else 0 (held, for the scrub repeat). */
  dpadVertical: number;
}

export function snapshotOf(gp: Gamepad): PadSnapshot {
  return {
    pressed: gp.buttons.map((b) => b.pressed),
    values: gp.buttons.map((b) => b.value),
    axes: Array.from(gp.axes),
  };
}

const EDGE_ACTIONS: [number, PadAction][] = [
  [BTN.A, 'lock'],
  [BTN.B, 'unfollow'],
  [BTN.X, 'flyTo'],
  [BTN.Y, 'joyride'],
  [BTN.LB, 'gearDown'],
  [BTN.RB, 'gearUp'],
  [BTN.DPAD_L, 'dpadLeft'],
  [BTN.DPAD_R, 'dpadRight'],
  [BTN.DPAD_D, 'dpadDown'],
  [BTN.START, 'start'],
];

/** Per-frame gamepad mapper: edges, chord and Select timing. Pure. */
export class PadMapper {
  private prev: boolean[] = [];
  private l3PendingMs: number | null = null;
  private r3PendingMs: number | null = null;
  private selectHeldMs = 0;
  private selectHoldFired = false;
  private selectConsumed = false;

  step(s: PadSnapshot, dtMs: number): PadFrame {
    const down = (i: number) => s.pressed[i] ?? false;
    const edge = (i: number) => down(i) && !(this.prev[i] ?? false);
    const actions: PadAction[] = [];

    for (const [i, a] of EDGE_ACTIONS) if (edge(i)) actions.push(a);

    let anyButtonPress = false;
    for (let i = 0; i < s.pressed.length; i++) {
      if (i !== BTN.START && edge(i)) anyButtonPress = true;
    }

    this.stepChord(down(BTN.L3), down(BTN.R3), edge(BTN.L3), edge(BTN.R3), dtMs, actions);
    this.stepSelect(down(BTN.SELECT), dtMs, actions);

    this.prev = s.pressed.slice();
    const ax = (i: number) => s.axes[i] ?? 0;
    const val = (i: number) => s.values[i] ?? 0;
    return {
      actions,
      anyButtonPress,
      move: {
        x: curve(ax(0)),
        vert: -curve(ax(1)), // stick up (−Y) = up
        // Half trigger travel = the gear's rated speed; full travel = a 2× dash.
        z: (triggerLinear(val(BTN.RT)) - triggerLinear(val(BTN.LT))) * 2,
      },
      look: { x: curve(ax(2)) * FLIGHT.rightStickScale, y: curve(ax(3)) * FLIGHT.rightStickScale },
      dpadVertical: down(BTN.DPAD_U) ? 1 : down(BTN.DPAD_D) ? -1 : 0,
    };
  }

  /**
   * Called when the controller acted on 'selectHold' (closed the scrubber), so
   * the release does not also count as a tap.
   */
  consumeSelect(): void {
    this.selectConsumed = true;
  }

  /**
   * L3 alone cycles back, R3 alone forward; both together toggle the ask bar.
   * Presses are never frame-synchronous, so a solo press waits up to
   * CHORD_WINDOW_MS (or until release) for the other stick before firing.
   */
  private stepChord(l3: boolean, r3: boolean, l3Edge: boolean, r3Edge: boolean, dtMs: number, out: PadAction[]): void {
    if ((l3Edge || r3Edge) && l3 && r3) {
      out.push('askBar');
      this.l3PendingMs = null;
      this.r3PendingMs = null;
      return;
    }
    if (l3Edge) this.l3PendingMs = 0;
    if (r3Edge) this.r3PendingMs = 0;
    if (this.l3PendingMs !== null) {
      this.l3PendingMs += dtMs;
      if (!l3 || this.l3PendingMs >= CHORD_WINDOW_MS) {
        out.push('cyclePrev');
        this.l3PendingMs = null;
      }
    }
    if (this.r3PendingMs !== null) {
      this.r3PendingMs += dtMs;
      if (!r3 || this.r3PendingMs >= CHORD_WINDOW_MS) {
        out.push('cycleNext');
        this.r3PendingMs = null;
      }
    }
  }

  /** Select: 'selectHold' once at SELECT_HOLD_MS; 'selectTap' on release unless the hold was consumed. */
  private stepSelect(sel: boolean, dtMs: number, out: PadAction[]): void {
    const wasDown = this.prev[BTN.SELECT] ?? false;
    if (sel) {
      if (!wasDown) {
        this.selectHeldMs = 0;
        this.selectHoldFired = false;
        this.selectConsumed = false;
      } else {
        this.selectHeldMs += dtMs;
      }
      if (!this.selectHoldFired && this.selectHeldMs >= SELECT_HOLD_MS) {
        this.selectHoldFired = true;
        out.push('selectHold');
      }
    } else if (wasDown) {
      if (!this.selectConsumed) out.push('selectTap');
      this.selectHeldMs = 0;
      this.selectHoldFired = false;
      this.selectConsumed = false;
    }
  }

  reset(): void {
    this.prev = [];
    this.l3PendingMs = null;
    this.r3PendingMs = null;
    this.selectHeldMs = 0;
    this.selectHoldFired = false;
    this.selectConsumed = false;
  }
}
