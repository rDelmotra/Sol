import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../../store/useStore';
import { simClock } from '../../time/SimClock';
import { cycleTimeField, stepUtcField, LIVE_EPSILON_MS } from '../../time/time-fields';
import { KeyboardFlightInput, PadMapper, snapshotOf, type KeyAction, type PadAction, type PadFrame } from '../input/flight-input';
import { ScrubRepeat } from '../input/scrub-repeat';
import { FLIGHT, FlightModel, GEAR_COUNT, proximityScales, rightVector, shiftGear } from './flight-model';

/** What the fly controller asks of the camera state machine. */
export interface FlyNav {
  resetCamera(): void;
  unfollow(): void;
  toggleLanding(): void;
  addJoyrideLookInput(deltaYawRad: number, deltaPitchRad: number): void;
}

type Store = ReturnType<typeof useStore.getState>;

/** World up for flight and yaw: scene +Y, the same up OrbitControls orbits about. */
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Free flight for the cockpit: keyboard and gamepad. Glue only — input mapping
 * lives in input/flight-input.ts, physics in flight-model.ts, the time-scrub
 * auto-repeat in input/scrub-repeat.ts.
 *
 * Moving and looking act only in the free camera in orbit. They move the camera
 * AND the OrbitControls target together, so mouse drag and the follow/joyride
 * state machine are untouched. Pad buttons work in every mode, on the ground too.
 *
 *   Keyboard: W/S along the view, A/D strafe, R/F world up/down, arrows look,
 *             [ ] gear, G fly-to, J joyride, C reset camera, L land / take off.
 *             (Q/E panels and ? are the UI's.)
 *   Pad:      left stick strafe + up/down, LT/RT back/forward, right stick look
 *             (free-look around the target while following), LB/RB gear,
 *             A lock reticle candidate, B unfollow, X fly-to, Y joyride,
 *             L3/R3 cycle candidates, L3+R3 ask bar, START controls sheet,
 *             D-pad ◄/► panels, ▼ land / take off, SELECT tap opens the time
 *             scrubber / hold closes it; while scrubbing D-pad ◄/► picks the
 *             field (► past SECOND parks on ↺), ▲/▼ steps it, A on ↺ returns
 *             to the present.
 *   Action keys and pad buttons (not movement) close the controls sheet.
 */
export class FlyController {
  private gear: number = FLIGHT.defaultGear;
  private readonly model = new FlightModel();
  private readonly keyboard: KeyboardFlightInput;
  private readonly pad = new PadMapper();
  private readonly scrub = new ScrubRepeat();
  private scrubViewMs = 0;
  private gamepadIndex: number | null = null;
  private gamepadWasConnected = false;

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly step = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly nav: FlyNav,
  ) {
    this.keyboard = new KeyboardFlightInput((a) => this.onKeyAction(a));
    window.addEventListener('gamepadconnected', this.onPadConnected);
    window.addEventListener('gamepaddisconnected', this.onPadDisconnected);
    this.publishGear();
  }

  /** Once per frame, before NavigationController.update (which runs controls.update). */
  update(dt: number): void {
    const gp = this.readGamepad();
    this.syncGamepadConnected(gp);
    const frame = gp ? this.pad.step(snapshotOf(gp), dt * 1000) : null;
    if (gp && frame) this.applyPad(gp, frame, dt);

    const store = useStore.getState();
    if (store.cameraMode !== 'free' || store.vantage === 'ground') {
      this.model.reset();
      return;
    }
    this.fly(dt, frame);
  }

  // ── Free flight ─────────────────────────────────────────────────────────────

  private fly(dt: number, frame: PadFrame | null): void {
    const prox = proximityScales(this.camera.position.length());

    const keyLook = this.keyboard.look();
    const lookX = (frame?.look.x ?? 0) + keyLook.x * FLIGHT.rightStickScale;
    const lookY = (frame?.look.y ?? 0) + keyLook.y * FLIGHT.rightStickScale;
    this.camera.getWorldDirection(this.forward);
    if (this.model.stepLook(lookX, lookY, dt, prox.turn, this.forward, UP, this.camera.quaternion)) {
      const lookDist = this.camera.position.distanceTo(this.controls.target);
      this.controls.target.copy(this.camera.position).addScaledVector(this.forward, lookDist);
    }

    const k = this.keyboard.moveIntent();
    const intent = {
      x: k.x + (frame?.move.x ?? 0),
      z: k.z + (frame?.move.z ?? 0),
      vert: k.vert + (frame?.move.vert ?? 0),
    };
    rightVector(this.forward, UP, this.camera.quaternion, this.right);
    const d = this.model.stepMove(
      intent, this.gear, prox.speed, dt, this.camera.position, this.forward, this.right, UP, this.step,
    );
    if (d) {
      this.camera.position.add(d);
      this.controls.target.add(d);
    }
  }

  // ── Keyboard actions ────────────────────────────────────────────────────────

  private onKeyAction(a: KeyAction): void {
    const store = useStore.getState();
    if (store.controlsSheetOpen) store.setControlsSheetOpen(false);
    switch (a) {
      case 'gearDown': this.shiftGear(-1); break;
      case 'gearUp': this.shiftGear(1); break;
      case 'flyTo': this.flyToSelected(store); break;
      case 'joyride': this.joyrideSelected(store); break;
      case 'reset': this.nav.resetCamera(); break;
      case 'land': this.nav.toggleLanding(); break;
      default: {
        const _never: never = a;
        return _never;
      }
    }
  }

  // ── Gamepad ─────────────────────────────────────────────────────────────────

  private applyPad(gp: Gamepad, f: PadFrame, dt: number): void {
    let store = useStore.getState();
    if (f.anyButtonPress && store.controlsSheetOpen) store.setControlsSheetOpen(false);

    for (const a of f.actions) {
      store = useStore.getState();
      switch (a) {
        case 'lock':
          if (store.scrubberMode && store.scrubFocusOnReset) {
            store.returnToPresent();
            store.setScrubFocusOnReset(false);
          } else if (store.reticleCandidateIndex !== null) {
            store.selectByIndex?.(store.reticleCandidateIndex);
            this.rumble(gp, 180, 1, 1);
          }
          break;
        case 'unfollow': this.nav.unfollow(); break;
        case 'flyTo': this.flyToSelected(store); break;
        case 'joyride': this.joyrideSelected(store); break;
        case 'gearDown': if (this.shiftGear(-1)) this.rumble(gp, 280, 0, 1); break;
        case 'gearUp': if (this.shiftGear(1)) this.rumble(gp, 280, 1, 0); break;
        case 'start': store.toggleControlsSheet(); break;
        case 'cyclePrev': store.cycleReticleCandidate(-1); break;
        case 'cycleNext': store.cycleReticleCandidate(1); break;
        case 'askBar': store.toggleAskBar(); break;
        case 'selectHold':
          if (store.scrubberMode) {
            store.setScrubberMode(false);
            this.pad.consumeSelect();
          }
          break;
        case 'selectTap': if (!store.scrubberMode) store.setScrubberMode(true); break;
        default: break; // D-pad edges are handled below, depending on scrub mode
      }
    }

    this.applyDpad(f, dt);

    // Right stick looks around the tracked object while following / flying.
    store = useStore.getState();
    if ((store.cameraMode === 'following' || store.cameraMode === 'flying') && (f.look.x || f.look.y)) {
      const rate = FLIGHT.followLookSpeed * dt;
      this.nav.addJoyrideLookInput(-f.look.x * rate, -f.look.y * rate);
    }
  }

  /** D-pad: time scrub while the scrubber is open, else panels and land / take off. */
  private applyDpad(f: PadFrame, dt: number): void {
    const has = (a: PadAction) => f.actions.includes(a);
    const store = useStore.getState();
    if (!store.scrubberMode) {
      this.commitScrub(this.scrub.step(0, 0).released);
      if (has('dpadLeft')) store.toggleAnalysisPanel();
      if (has('dpadRight')) store.toggleFocusPanel();
      if (has('dpadDown')) this.nav.toggleLanding();
      return;
    }

    const displaced = Math.abs(simClock.now() - Date.now()) > LIVE_EPSILON_MS;
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

    const now = useStore.getState();
    const dir = now.scrubFocusOnReset ? 0 : f.dpadVertical;
    const fresh = dir !== 0 && dir !== this.scrub.heldDir;
    const { steps, released } = this.scrub.step(dir, dt * 1000);
    this.commitScrub(released);
    if (steps === 0) return;
    if (fresh) this.scrubViewMs = simClock.now();
    for (let i = 0; i < steps; i++) this.scrubViewMs = stepUtcField(this.scrubViewMs, now.scrubField, dir);
    // Only on frames that stepped: an idle preview would keep the scrub "hot" and defer the reseed.
    now.scrubPreview(new Date(this.scrubViewMs));
  }

  /** A ▲/▼ hold ended: commit the time it landed on (god1's full reseed path). */
  private commitScrub(releasedDir: number): void {
    if (releasedDir !== 0) useStore.getState().reviewAt(new Date(this.scrubViewMs));
  }

  private readGamepad(): Gamepad | null {
    const pads = navigator.getGamepads?.();
    if (!pads) return null;
    // Some browsers never fire 'gamepadconnected' for a pad already in use when the
    // tab loaded, so fall back to the first pad found.
    const byIndex = this.gamepadIndex !== null ? pads[this.gamepadIndex] : null;
    return byIndex ?? Array.from(pads).find((p): p is Gamepad => p !== null) ?? null;
  }

  private syncGamepadConnected(gp: Gamepad | null): void {
    const connected = gp !== null;
    if (connected === this.gamepadWasConnected) return;
    this.gamepadWasConnected = connected;
    this.pad.reset();
    this.commitScrub(this.scrub.step(0, 0).released);
    const store = useStore.getState();
    store.setGamepadConnected(connected);
    if (!connected) store.setReticleCandidates([]);
  }

  private onPadConnected = (e: GamepadEvent): void => {
    this.gamepadIndex = e.gamepad.index;
  };

  private onPadDisconnected = (e: GamepadEvent): void => {
    if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
  };

  /** Short rumble; no-op where unsupported. weak = right motor, strong = left. */
  private rumble(gp: Gamepad, durationMs: number, weakMagnitude: number, strongMagnitude: number): void {
    gp.vibrationActuator
      ?.playEffect('dual-rumble', { duration: durationMs, startDelay: 0, weakMagnitude, strongMagnitude })
      .catch(() => {});
  }

  // ── Shared ──────────────────────────────────────────────────────────────────

  /** Returns true when the gear actually changed. */
  private shiftGear(delta: number): boolean {
    const next = shiftGear(this.gear, delta);
    if (next === this.gear) return false;
    this.gear = next;
    this.publishGear();
    return true;
  }

  private publishGear(): void {
    useStore.getState().setCameraGearState(this.gear, GEAR_COUNT, FLIGHT.gearsMps[this.gear]);
  }

  private flyToSelected(store: Store): void {
    if (store.selectedIndex !== null) store.triggerFlyTo?.(store.selectedIndex);
  }

  private joyrideSelected(store: Store): void {
    if (store.selectedIndex !== null) store.triggerJoyride?.(store.selectedIndex);
  }

  dispose(): void {
    this.keyboard.dispose();
    window.removeEventListener('gamepadconnected', this.onPadConnected);
    window.removeEventListener('gamepaddisconnected', this.onPadDisconnected);
  }
}
