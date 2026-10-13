/**
 * Activity tracker: when did the user last touch anything? Feeds the idle frame
 * governor (render/frame-governor.ts). Passive window listeners only; each one
 * does a single timestamp write. No store, no three.js, no per-frame cost.
 * Key and button state is deliberately not tracked: a key released while another
 * app has focus (or under Cmd on a Mac) never reports keyup, and a stuck "held"
 * flag would pin the loop at full rate. Key repeat plus the 2.5 s window cover it.
 *
 * Gamepads raise no events, so the engine calls {@link pollGamepad} once per
 * display tick while a pad is connected.
 */

/** Anything that can add and remove listeners: the window in the app, a plain EventTarget in tests. */
export interface ActivityTarget {
  addEventListener(type: string, listener: (e: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (e: Event) => void, options?: EventListenerOptions): void;
}
export interface PadLike {
  axes: ArrayLike<number>;
  buttons: ArrayLike<{ pressed: boolean; value?: number }>;
}

/** Events that count as "the user did something". */
export const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'wheel',
  'keydown',
  'keyup',
  'touchstart',
  'touchmove',
  'touchend',
  'gamepadconnected',
  'gamepaddisconnected',
  'visibilitychange',
  'resize',
] as const;

/** A stick must move this far from centre to count (a touch above the flight deadzone, so drift is ignored). */
export const PAD_ACTIVITY_DEADZONE = 0.25;
export const PAD_TRIGGER_THRESHOLD = 0.2;

/** True when any connected pad has a stick pushed, a button down, or a trigger pulled. */
export function padHasInput(pads: ArrayLike<PadLike | null> | null | undefined): boolean {
  if (!pads) return false;
  for (let p = 0; p < pads.length; p++) {
    const pad = pads[p];
    if (!pad) continue;
    for (let a = 0; a < pad.axes.length; a++) {
      if (Math.abs(pad.axes[a]) >= PAD_ACTIVITY_DEADZONE) return true;
    }
    for (let b = 0; b < pad.buttons.length; b++) {
      const btn = pad.buttons[b];
      if (btn.pressed || (btn.value ?? 0) >= PAD_TRIGGER_THRESHOLD) return true;
    }
  }
  return false;
}

export interface ActivityTrackerOptions {
  target?: ActivityTarget;
  /** Clock in ms; the governor compares it with its own `nowMs`, so use performance.now(). */
  now?: () => number;
  hasFocus?: () => boolean;
  getPads?: () => ArrayLike<PadLike | null> | null | undefined;
}

/** Passive, capturing: sees the event first and can never block scrolling or touch. */
const LISTEN: AddEventListenerOptions & EventListenerOptions = { passive: true, capture: true };
/**
 * Window focus / blur. NOT capturing: focus and blur do not bubble, so this hears only the window's
 * own, never an input element losing focus inside the page.
 */
const LISTEN_WINDOW: AddEventListenerOptions & EventListenerOptions = { passive: true };

export class ActivityTracker {
  /** performance.now() of the last activity. Starts "just now", so boot runs at full rate. */
  lastActivityMs: number;
  windowFocused: boolean;
  private readonly target: ActivityTarget;
  private readonly now: () => number;
  private readonly getPads: () => ArrayLike<PadLike | null> | null | undefined;
  private disposed = false;

  constructor(opts: ActivityTrackerOptions = {}) {
    this.target = opts.target ?? window;
    this.now = opts.now ?? (() => performance.now());
    this.getPads = opts.getPads ?? (() => navigator.getGamepads?.());
    this.windowFocused = (opts.hasFocus ?? (() => document.hasFocus()))();
    this.lastActivityMs = this.now();
    for (const type of ACTIVITY_EVENTS) this.target.addEventListener(type, this.onActivity, LISTEN);
    this.target.addEventListener('focus', this.onFocus, LISTEN_WINDOW);
    this.target.addEventListener('blur', this.onBlur, LISTEN_WINDOW);
  }

  /** Count "now" as activity (the engine calls this for things that are not input events). */
  mark(): void {
    this.lastActivityMs = this.now();
  }

  /** Once per display tick while a pad is connected: counts a pushed stick or pressed button as activity. */
  pollGamepad(): void {
    if (padHasInput(this.getPads())) this.mark();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const type of ACTIVITY_EVENTS) this.target.removeEventListener(type, this.onActivity, LISTEN);
    this.target.removeEventListener('focus', this.onFocus, LISTEN_WINDOW);
    this.target.removeEventListener('blur', this.onBlur, LISTEN_WINDOW);
  }

  private readonly onActivity = (): void => {
    this.lastActivityMs = this.now();
  };
  private readonly onFocus = (): void => {
    this.windowFocused = true;
    this.lastActivityMs = this.now();
  };
  private readonly onBlur = (): void => {
    this.windowFocused = false;
  };
}
