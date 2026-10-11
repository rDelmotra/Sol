/**
 * Keyboard-style auto-repeat for the gamepad time scrub (D-pad ▲▼ while the
 * scrubber is open): one step on press, a pause, then a steady stream of whole
 * steps. Deliberately not a continuous rate — every tick lands on a whole unit
 * of the active time field. Pure; driven by frame deltas.
 */

/** Hold this long before the repeat starts. */
export const SCRUB_REPEAT_DELAY_MS = 420;
/** One further step per this much hold time, after the delay. */
export const SCRUB_REPEAT_INTERVAL_MS = 110;

export class ScrubRepeat {
  private dir = 0;
  private heldMs = 0;
  private taken = 0;

  /** Direction currently held (-1, 0, +1). */
  get heldDir(): number {
    return this.dir;
  }

  /**
   * Advance one frame with the held direction. Returns how many NEW steps are due
   * this frame (in the held direction), and `released` = the previous direction
   * when a hold just ended or flipped (the caller commits there).
   */
  step(dir: number, dtMs: number): { steps: number; released: number } {
    if (dir !== this.dir) {
      const released = this.dir;
      this.dir = dir;
      this.heldMs = 0;
      this.taken = dir !== 0 ? 1 : 0; // a fresh press is exactly one step, now
      return { steps: dir !== 0 ? 1 : 0, released };
    }
    if (dir === 0) return { steps: 0, released: 0 };
    this.heldMs += dtMs;
    // Count steps against total hold time (not a remainder) so the rate never drifts.
    const due = this.heldMs < SCRUB_REPEAT_DELAY_MS
      ? 1
      : 2 + Math.floor((this.heldMs - SCRUB_REPEAT_DELAY_MS) / SCRUB_REPEAT_INTERVAL_MS);
    const steps = Math.max(0, due - this.taken);
    this.taken = Math.max(this.taken, due);
    return { steps, released: 0 };
  }

  reset(): void {
    this.dir = 0;
    this.heldMs = 0;
    this.taken = 0;
  }
}
