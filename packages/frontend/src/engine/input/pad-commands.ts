import type { HudPadAction } from '../../bindings/bindings';
import type { AppState } from '../../store/types';

/**
 * Gamepad buttons that drive the HUD and the time console, as a pure router:
 * HudPadAction → store calls. No camera, no THREE, no Gamepad, so every button
 * is unit-tested against a plain fake store (pad-commands.test.ts). Flight
 * buttons (gears, fly-to, joyride, unfollow) stay in FlyController; the D-pad
 * is gamepad-scrub.ts. Which button is which: bindings/bindings.ts.
 */

/** The slice of the store the router reads and calls. */
export type PadHudStore = Pick<
  AppState,
  | 'controlsSheetOpen'
  | 'setControlsSheetOpen'
  | 'toggleControlsSheet'
  | 'toggleAskBar'
  | 'cycleReticleCandidate'
  | 'reticleCandidateIndex'
  | 'selectByIndex'
  | 'scrubberMode'
  | 'setScrubberMode'
  | 'scrubFocusOnReset'
  | 'setScrubFocusOnReset'
  | 'returnToPresent'
>;

/** What a button can ask of the pad hardware / mapper. */
export interface PadEffects {
  /** Short rumble; no-op where unsupported. weak = right motor, strong = left. */
  rumble(durationMs: number, weakMagnitude: number, strongMagnitude: number): void;
  /** The Select hold was acted on, so its release must not count as a tap. */
  consumeSelect(): void;
}

export class PadCommandRouter {
  /** `getStore` is read fresh for every action: an earlier action in a frame can change what a later one sees. */
  constructor(private readonly getStore: () => PadHudStore) {}

  /** Any fresh button press except START closes the controls sheet. */
  dismissControlsSheet(): void {
    const store = this.getStore();
    if (store.controlsSheetOpen) store.setControlsSheetOpen(false);
  }

  handle(action: HudPadAction, fx: PadEffects): void {
    const store = this.getStore();
    switch (action) {
      case 'lock':
        if (store.scrubberMode && store.scrubFocusOnReset) {
          store.returnToPresent();
          store.setScrubFocusOnReset(false);
        } else if (store.reticleCandidateIndex !== null) {
          store.selectByIndex?.(store.reticleCandidateIndex);
          fx.rumble(180, 1, 1);
        }
        break;
      case 'start': store.toggleControlsSheet(); break;
      case 'cyclePrev': store.cycleReticleCandidate(-1); break;
      case 'cycleNext': store.cycleReticleCandidate(1); break;
      case 'askBar': store.toggleAskBar(); break;
      case 'selectHold':
        if (store.scrubberMode) {
          store.setScrubberMode(false);
          fx.consumeSelect();
        }
        break;
      case 'selectTap':
        if (!store.scrubberMode) store.setScrubberMode(true);
        break;
      default: {
        const _never: never = action;
        return _never;
      }
    }
  }
}
