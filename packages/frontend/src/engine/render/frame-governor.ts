/**
 * Idle frame governor: pure rules for how often the render loop may run a full
 * frame. Nothing here touches the DOM, the store or three.js.
 *
 * The loop keeps asking the browser for a frame at display rate. Each time the
 * governor can say "skip": the loop returns at once (no update, no draw) and
 * the last picture stays on screen. Redrawing an unchanged globe 60 times a
 * second is what made an idle cockpit run hot.
 *
 *   ACTIVE  -> 0 ms   every display frame (60 or 120 fps)
 *   IDLE    -> 50 ms  20 fps, window focused
 *   BLURRED -> 100 ms 10 fps, window visible but not focused
 *
 * ACTIVE means the user is, or just was, doing something, or something is
 * moving on its own. See {@link isActive}. `?perf=full` forces ACTIVE always.
 */

/** Input in the last 2.5 s counts as "just now" (covers camera damping tails). */
export const ACTIVE_WINDOW_MS = 2500;
export const IDLE_FRAME_MS = 50;
export const UNFOCUSED_FRAME_MS = 100;
/**
 * A frame may start this early, ms. Display ticks land on multiples of 16.7 ms
 * (or 8.3 ms), so "50 ms since the last frame" would otherwise often fall just
 * short and wait a whole extra tick (15 fps instead of 20).
 */
export const FRAME_SLACK_MS = 5;

export interface FrameGovernorInputs {
  /** performance.now() of this display tick. */
  nowMs: number;
  /** performance.now() of the last pointer / wheel / key / touch / pad / resize event. */
  lastActivityMs: number;
  /** Sim clock rate. 1 = live. 0 = paused (nothing moves, so it may idle). Anything else is time-lapse. */
  simRate: number;
  /** Time scrubber open, view away from now (review), or a glide back to live is running. */
  scrubbing: boolean;
  /** The camera is flying, returning, or following / riding an object. */
  cameraBusy: boolean;
  /** Standing on the ground looking up. */
  groundView: boolean;
  /** Catalog or history still loading. */
  loading: boolean;
  windowFocused: boolean;
  /** `?perf=full` escape hatch. */
  forceFull: boolean;
}

/** True when the loop must run at display rate. */
export function isActive(i: FrameGovernorInputs): boolean {
  if (i.forceFull) return true;
  if (i.nowMs - i.lastActivityMs < ACTIVE_WINDOW_MS) return true;
  if (i.simRate !== 0 && i.simRate !== 1) return true; // time-lapse, reverse, or a bad value
  return i.scrubbing || i.cameraBusy || i.groundView || i.loading;
}

/** Minimum ms between full frames: 0 = every display tick. */
export function frameIntervalMs(i: FrameGovernorInputs): number {
  if (isActive(i)) return 0;
  return i.windowFocused ? IDLE_FRAME_MS : UNFOCUSED_FRAME_MS;
}

/** Whether a frame that last ran at `lastFrameMs` may run at `nowMs` under `intervalMs`. */
export function shouldRunFrame(nowMs: number, lastFrameMs: number, intervalMs: number): boolean {
  if (intervalMs <= 0) return true;
  const elapsed = nowMs - lastFrameMs;
  return !(elapsed >= 0) || elapsed >= intervalMs - FRAME_SLACK_MS; // a clock that went backwards just runs
}

/** The only state: when the last full frame ran. */
export class FrameGovernor {
  private lastFrameMs = Number.NEGATIVE_INFINITY;

  /** Ask once per display tick. Returns true when the caller should run a full frame now. */
  shouldRun(inputs: FrameGovernorInputs): boolean {
    if (!shouldRunFrame(inputs.nowMs, this.lastFrameMs, frameIntervalMs(inputs))) return false;
    this.lastFrameMs = inputs.nowMs;
    return true;
  }
}

/** `?perf=full` in the URL, or `full` saved under the perf key in localStorage. */
export function isPerfFull(search: string, stored: string | null): boolean {
  return new URLSearchParams(search).get('perf') === 'full' || stored === 'full';
}
