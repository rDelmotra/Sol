import type { PadAction } from '../../bindings/bindings';
import { cycleTimeField, stepUtcField, LIVE_EPSILON_MS } from '../../time/time-fields';
import type { AppState } from '../../store/types';
import { ScrubRepeat } from './scrub-repeat';

/**
 * The D-pad, whose meaning depends on the time scrubber:
 *   scrubber closed  ◄ / ► toggle the ANALYSIS / FOCUS panes, ▼ lands / takes off
 *   scrubber open    ◄ / ► pick the time field (► past SECOND parks on ↺, which
 *                    exists only while the clock is displaced), ▲ / ▼ step the
 *                    field with keyboard-style auto-repeat (scrub-repeat.ts);
 *                    ending a hold commits the time it landed on.
 * No camera and no Gamepad: the store, the clock and landing are injected, so
 * the focus rules are unit-tested (gamepad-scrub.test.ts).
 */

/** The slice of the store the driver reads and calls. */
export type ScrubStore = Pick<
  AppState,
  | 'scrubberMode'
  | 'scrubFocusOnReset'
  | 'scrubField'
  | 'setScrubFocusOnReset'
  | 'setScrubField'
  | 'scrubPreview'
  | 'reviewAt'
  | 'toggleAnalysisPanel'
  | 'toggleFocusPanel'
>;

export interface ScrubDeps {
  /** Read fresh at each use. */
  getStore(): ScrubStore;
  /** The simulation clock, ms. */
  simNow(): number;
  /** Wall clock, ms: the clock is "displaced" when it differs from this. */
  wallNow(): number;
  toggleLanding(): void;
}

/** The part of a pad frame the D-pad needs. */
export interface DpadFrame {
  actions: readonly PadAction[];
  /** D-pad ▲ = +1, ▼ = -1, else 0. */
  dpadVertical: number;
}

export class GamepadScrubDriver {
  private readonly repeat = new ScrubRepeat();
  private viewMs = 0;

  constructor(private readonly deps: ScrubDeps) {}

  /** Once per pad frame, after the frame's other buttons. */
  step(f: DpadFrame, dtMs: number): void {
    const has = (a: PadAction) => f.actions.includes(a);
    const store = this.deps.getStore();
    if (!store.scrubberMode) {
      this.commit(this.repeat.step(0, 0).released);
      if (has('dpadLeft')) store.toggleAnalysisPanel();
      if (has('dpadRight')) store.toggleFocusPanel();
      if (has('dpadDown')) this.deps.toggleLanding();
      return;
    }

    const displaced = Math.abs(this.deps.simNow() - this.deps.wallNow()) > LIVE_EPSILON_MS;
    if (has('dpadRight')) {
      if (store.scrubFocusOnReset) {
        // Already at the end of the row.
      } else if (store.scrubField === 'second' && displaced) {
        store.setScrubFocusOnReset(true); // ↺ exists only while displaced in time
      } else {
        store.setScrubField(cycleTimeField(store.scrubField, 1));
      }
    }
    if (has('dpadLeft')) {
      if (store.scrubFocusOnReset) store.setScrubFocusOnReset(false);
      else store.setScrubField(cycleTimeField(store.scrubField, -1));
    }

    const now = this.deps.getStore();
    const dir = now.scrubFocusOnReset ? 0 : f.dpadVertical;
    const fresh = dir !== 0 && dir !== this.repeat.heldDir;
    const { steps, released } = this.repeat.step(dir, dtMs);
    this.commit(released);
    if (steps === 0) return;
    if (fresh) this.viewMs = this.deps.simNow();
    for (let i = 0; i < steps; i++) this.viewMs = stepUtcField(this.viewMs, now.scrubField, dir);
    // Only on frames that stepped: an idle preview would keep the scrub "hot" and defer the reseed.
    now.scrubPreview(new Date(this.viewMs));
  }

  /** Pad gone or reset: end any hold, committing where it landed. */
  release(): void {
    this.commit(this.repeat.step(0, 0).released);
  }

  /** A ▲/▼ hold ended: commit the time it landed on (god1's full reseed path). */
  private commit(releasedDir: number): void {
    if (releasedDir !== 0) this.deps.getStore().reviewAt(new Date(this.viewMs));
  }
}
