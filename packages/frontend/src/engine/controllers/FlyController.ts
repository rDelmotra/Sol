import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../../store/useStore';

/**
 * Global flight feel — all the tunable knobs in one place (spec step 1).
 * Speeds are real metric presets (m/s); 1 scene unit = 1 Earth radius = 6371 km.
 */
const FLIGHT = {
  deadzone: 0.15,
  exponent: 2, // input response curve: sign(v) * |v|^exponent (fine near center)
  moveDamping: 6, // velocity glide rate (1/s); lower = more "floating astronaut" drift
  lookSpeed: 1.2, // right-stick max turn rate, rad/s at full deflection
  lookDamping: 10, // look glide rate (1/s)
  /** Metric speed gears (m/s), half-decade steps. Same top (100,000 km/s) as the 5-gear set; finer low end. */
  gearsMps: [3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000, 3_000_000, 10_000_000, 30_000_000, 100_000_000],
  defaultGear: 5, // 1,000 km/s ≈ brisk cruise
  earthRadiusM: 6_371_000, // 1 scene unit
  minRadius: 1.05, // hard surface clamp (scene: Earth radius = 1)
  proximityRamp: 0.35, // ER of altitude over which speed/turn ramp up to full
  proximityFloor: 0.05, // speed never fully zero — can still crawl off the surface
} as const;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Space Engine-style free-flight for the cockpit space view. Additive to
 * OrbitControls: only runs in `free` camera mode (not following/joyriding, not
 * the dome observer rig). It flies by translating BOTH the camera and the orbit
 * target together, so mouse-drag look and the follow/joyride state machine are
 * untouched.
 *
 * Movement is one unified pipeline for keyboard + gamepad: inputs build a target
 * velocity, the actual velocity glides toward it (inertia), and forward follows
 * the camera's true view direction (look at the Moon + push forward → toward the
 * Moon). Vertical is world-up. Speed is a set of metric gears; everything is
 * tethered to Earth's centre so max speed + turn sensitivity scale down near the
 * surface and you can't crash through.
 *
 * The mouse/trackpad is deliberately NOT touched here — drag-rotate and
 * scroll/pinch-zoom stay with OrbitControls (the default "phone-like" Three.js
 * feel), so the three input modes (touch/mouse · keyboard · gamepad) are decoupled.
 *
 *   W / S      forward / backward (along the view axis)
 *   A / D      strafe left / right
 *   R / F      up / down (world-vertical)
 *   [ / ]      gear down / up
 *   G          auto-travel (fly-to) the selected object
 *
 * Gamepad (first connected pad, standard mapping):
 *   right stick   look around (squared curve, damped)
 *   left stick    forward/back/strafe
 *   LT / RT       down / up (world-vertical; RT − LT)
 *   LB / RB       gear down / up
 */
export class FlyController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly keys = new Set<string>();
  private gear: number = FLIGHT.defaultGear;

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  /** Persistent world-space velocity that powers the inertia glide. */
  private readonly velocity = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly step = new THREE.Vector3();

  private yawSpeed = 0;
  private pitchSpeed = 0;
  private lbWasPressed = false;
  private rbWasPressed = false;

  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onGamepadConnected: (e: GamepadEvent) => void;
  private readonly onGamepadDisconnected: (e: GamepadEvent) => void;
  private gamepadIndex: number | null = null;

  private static readonly MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'r', 'f']);

  constructor(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
    this.camera = camera;
    this.controls = controls;

    this.onKeyDown = (e) => this.handleKeyDown(e);
    this.onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this.onGamepadConnected = (e) => {
      this.gamepadIndex = e.gamepad.index;
      console.info(`[FlyController] gamepad connected: "${e.gamepad.id}" (index ${e.gamepad.index}, mapping: ${e.gamepad.mapping || 'none'})`);
    };
    this.onGamepadDisconnected = (e) => {
      if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
      console.info(`[FlyController] gamepad disconnected: "${e.gamepad.id}"`);
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('gamepadconnected', this.onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);

    this.publishGear();
  }

  private static isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (FlyController.isTyping(e)) return;
    const k = e.key.toLowerCase();
    if (k === '[') {
      this.shiftGear(-1);
      return;
    }
    if (k === ']') {
      this.shiftGear(1);
      return;
    }
    if (k === 'g') {
      this.flyToSelected();
      return;
    }
    if (FlyController.MOVE_KEYS.has(k)) {
      this.keys.add(k);
    }
  }

  private flyToSelected(): void {
    const store = useStore.getState();
    if (store.selectedIndex == null || !store.triggerFlyTo) return;
    store.triggerFlyTo(store.selectedIndex);
  }

  private shiftGear(delta: number): void {
    const next = Math.max(0, Math.min(FLIGHT.gearsMps.length - 1, this.gear + delta));
    if (next === this.gear) return;
    this.gear = next;
    this.publishGear();
  }

  private publishGear(): void {
    useStore.getState().setCameraGearState(this.gear, FLIGHT.gearsMps[this.gear]);
  }

  /** Deadzone + sign-preserving exponent curve for one analog axis. */
  private static curve(v: number): number {
    if (Math.abs(v) < FLIGHT.deadzone) return 0;
    return Math.sign(v) * Math.pow(Math.abs(v), FLIGHT.exponent);
  }

  private readGamepad(): Gamepad | null {
    const pads = navigator.getGamepads?.();
    if (!pads) return null;
    // Prefer the last-connected index; some browsers never fire 'gamepadconnected'
    // (e.g. a pad already held/moved before the tab loaded), so fall back to a scan.
    let gp = this.gamepadIndex != null ? pads[this.gamepadIndex] : null;
    if (!gp) gp = Array.from(pads).find((p): p is Gamepad => p != null) ?? null;
    return gp;
  }

  /** Called once per frame from the engine loop, before controls.update(). */
  update(dt: number): void {
    const store = useStore.getState();
    // Only fly in the free space view — never fight follow/joyride or the dome rig.
    if (store.cameraMode !== 'free' || store.visibilityMode === 'dome') return;

    const gp = this.readGamepad();

    // ── Earth reference frame: distance to Earth centre (mesh sits at origin). ──
    // Speed + turn sensitivity ramp up with altitude so you slow down near the
    // surface and can't crash through.
    const camDist = this.camera.position.length();
    const t = clamp01((camDist - FLIGHT.minRadius) / FLIGHT.proximityRamp);
    const speedScale = FLIGHT.proximityFloor + (1 - FLIGHT.proximityFloor) * t;
    const turnScale = 0.5 + 0.5 * t;

    this.updateGears(gp);
    this.updateLook(dt, gp, turnScale);
    this.updateMovement(dt, gp, speedScale);
  }

  /** Bumper gear shifts — edge-detected (one step per fresh press). */
  private updateGears(gp: Gamepad | null): void {
    const lb = gp?.buttons[4]?.pressed ?? false;
    const rb = gp?.buttons[5]?.pressed ?? false;
    if (lb && !this.lbWasPressed) this.shiftGear(-1);
    if (rb && !this.rbWasPressed) this.shiftGear(1);
    this.lbWasPressed = lb;
    this.rbWasPressed = rb;
  }

  /** Right-stick look: squared curve + damped rotation speed, scaled near surface. */
  private updateLook(dt: number, gp: Gamepad | null, turnScale: number): void {
    const rx = gp ? FlyController.curve(gp.axes[2] ?? 0) : 0;
    const ry = gp ? FlyController.curve(gp.axes[3] ?? 0) : 0;

    // TargetSpeed = MaxTurnRate × curvedOutput × dt; ActualSpeed lerps toward it,
    // so look eases in and keeps drifting a frame or two after release.
    const rate = FLIGHT.lookSpeed * turnScale * dt;
    const targetYaw = -rx * rate;
    const targetPitch = -ry * rate;
    const lerpT = Math.min(1, FLIGHT.lookDamping * dt);
    this.yawSpeed += (targetYaw - this.yawSpeed) * lerpT;
    this.pitchSpeed += (targetPitch - this.pitchSpeed) * lerpT;

    if (Math.abs(this.yawSpeed) < 1e-6 && Math.abs(this.pitchSpeed) < 1e-6) return;

    const lookDist = this.camera.position.distanceTo(this.controls.target);
    this.camera.getWorldDirection(this.forward);
    this.forward.applyAxisAngle(this.worldUp, this.yawSpeed);
    this.right.copy(this.forward).cross(this.worldUp).normalize();
    this.forward.applyAxisAngle(this.right, this.pitchSpeed).normalize();
    this.controls.target.copy(this.camera.position).addScaledVector(this.forward, lookDist);
  }

  /** Unified keyboard + gamepad movement with an inertia glide (spec steps 2–5). */
  private updateMovement(dt: number, gp: Gamepad | null, speedScale: number): void {
    // ── Local intent: sum keyboard (digital ±1) + gamepad (curved analog). ──
    let localX = 0; // strafe (right +)
    let localZ = 0; // forward (+)
    let localVert = 0; // world-up (+)
    if (this.keys.has('d')) localX += 1;
    if (this.keys.has('a')) localX -= 1;
    if (this.keys.has('w')) localZ += 1;
    if (this.keys.has('s')) localZ -= 1;
    if (this.keys.has('r')) localVert += 1;
    if (this.keys.has('f')) localVert -= 1;
    if (gp) {
      localX += FlyController.curve(gp.axes[0] ?? 0);
      localZ += -FlyController.curve(gp.axes[1] ?? 0); // stick up (−Y) = forward
      localVert += FlyController.curve(gp.buttons[7]?.value ?? 0); // RT up
      localVert -= FlyController.curve(gp.buttons[6]?.value ?? 0); // LT down
    }

    // Clamp planar magnitude to 1 (no diagonal speed-up); vertical to ±1.
    const planar = Math.hypot(localX, localZ);
    if (planar > 1) {
      localX /= planar;
      localZ /= planar;
    }
    localVert = Math.max(-1, Math.min(1, localVert));

    // ── World-space target velocity: forward follows the true view direction. ──
    const unitsPerSec = FLIGHT.gearsMps[this.gear] / FLIGHT.earthRadiusM;
    const maxSpeed = unitsPerSec * speedScale;
    this.camera.getWorldDirection(this.forward);
    this.right.copy(this.forward).cross(this.worldUp).normalize();
    this.target
      .set(0, 0, 0)
      .addScaledVector(this.right, localX)
      .addScaledVector(this.forward, localZ)
      .addScaledVector(this.worldUp, localVert)
      .multiplyScalar(maxSpeed);

    // ── Glide: actual velocity eases toward target (floating drift). ──
    this.velocity.lerp(this.target, Math.min(1, FLIGHT.moveDamping * dt));
    if (this.velocity.lengthSq() < 1e-16) return;

    // ── Integrate + surface clamp: move camera and orbit target together. ──
    this.step.copy(this.velocity).multiplyScalar(Math.min(dt, 0.05));
    if (this.camera.position.clone().add(this.step).length() >= FLIGHT.minRadius) {
      this.camera.position.add(this.step);
      this.controls.target.add(this.step);
    } else {
      this.velocity.set(0, 0, 0); // bumped the floor — kill the glide, don't tunnel
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('gamepadconnected', this.onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);
    this.keys.clear();
  }
}
