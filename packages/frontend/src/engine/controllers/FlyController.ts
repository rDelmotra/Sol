import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../../store/useStore';
import { simClock } from '../../time/SimClock';
import { isDpadAction, isFlightPadAction, type FlightPadAction } from '../../bindings/bindings';
import { KeyboardFlightInput, PadMapper, snapshotOf, type KeyAction, type PadFrame } from '../input/flight-input';
import { GamepadScrubDriver } from '../input/gamepad-scrub';
import { PadCommandRouter, type PadEffects } from '../input/pad-commands';
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
 * Free flight for the cockpit: camera only. Which key / button is which lives
 * in bindings/bindings.ts; raw input becomes actions in input/flight-input.ts;
 * physics is flight-model.ts. This class acts on the actions whose handler is
 * 'flight' and hands everything else off:
 *   HUD buttons (lock, START, L3/R3, SELECT)   input/pad-commands.ts  PadCommandRouter
 *   D-pad (panes, land, time-scrub)            input/gamepad-scrub.ts  GamepadScrubDriver
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
 *             B unfollow, X fly-to, Y joyride, D-pad ▼ land / take off.
 *   Action keys and pad buttons (not movement) close the controls sheet.
 */
export class FlyController {
  private gear: number = FLIGHT.defaultGear;
  private readonly model = new FlightModel();
  private readonly keyboard: KeyboardFlightInput;
  private readonly pad = new PadMapper();
  private readonly hud = new PadCommandRouter(() => useStore.getState());
  private readonly scrub: GamepadScrubDriver;
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
    this.scrub = new GamepadScrubDriver({
      getStore: () => useStore.getState(),
      simNow: () => simClock.now(),
      wallNow: () => Date.now(),
      toggleLanding: () => this.nav.toggleLanding(),
    });
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
    this.hud.dismissControlsSheet();
    const store = useStore.getState();
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
    if (f.anyButtonPress) this.hud.dismissControlsSheet();

    const fx: PadEffects = {
      rumble: (ms, weak, strong) => this.rumble(gp, ms, weak, strong),
      consumeSelect: () => this.pad.consumeSelect(),
    };
    for (const a of f.actions) {
      if (isDpadAction(a)) continue; // below, after the other buttons: depends on scrub mode
      if (isFlightPadAction(a)) this.onFlightPad(a, gp);
      else this.hud.handle(a, fx);
    }

    this.scrub.step(f, dt * 1000);

    // Right stick looks around the tracked object while following / flying.
    const store = useStore.getState();
    if ((store.cameraMode === 'following' || store.cameraMode === 'flying') && (f.look.x || f.look.y)) {
      const rate = FLIGHT.followLookSpeed * dt;
      this.nav.addJoyrideLookInput(-f.look.x * rate, -f.look.y * rate);
    }
  }

  private onFlightPad(a: FlightPadAction, gp: Gamepad): void {
    switch (a) {
      case 'unfollow': this.nav.unfollow(); break;
      case 'flyTo': this.flyToSelected(useStore.getState()); break;
      case 'joyride': this.joyrideSelected(useStore.getState()); break;
      case 'gearDown': if (this.shiftGear(-1)) this.rumble(gp, 280, 0, 1); break;
      case 'gearUp': if (this.shiftGear(1)) this.rumble(gp, 280, 1, 0); break;
      default: {
        const _never: never = a;
        return _never;
      }
    }
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
    this.scrub.release();
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
