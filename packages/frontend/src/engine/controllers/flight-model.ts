import * as THREE from 'three';
import { DEFAULT_GEAR, EARTH_RADIUS_M, GEARS_MPS, GEAR_COUNT } from '../../constants/flight-gears';

/**
 * Free-flight physics, pure: no DOM, no store, no camera object. FlyController
 * feeds it intent and a view basis; it returns how far to move and turn.
 *
 * Speeds are real metric gears (m/s). 1 scene unit = 1 Earth radius = 6371 km.
 */
export const FLIGHT = {
  deadzone: 0.15,
  /** Stick response curve: sign(v)·|v|^exponent (fine control near centre). */
  exponent: 2,
  /** Velocity glide rate (1/s); lower = more "floating astronaut" drift. */
  moveDamping: 6,
  /** Look turn rate at full deflection, rad/s. */
  lookSpeed: 1.2,
  /** Look glide rate (1/s). */
  lookDamping: 10,
  /** Right stick and arrow keys look sensitivity multiplier. */
  rightStickScale: 0.5,
  /** Right-stick free-look rate while following/joyriding, rad/s. */
  followLookSpeed: 1.6,
  gearsMps: GEARS_MPS,
  defaultGear: DEFAULT_GEAR,
  earthRadiusM: EARTH_RADIUS_M,
  /** Hard surface clamp, scene units (Earth radius = 1). */
  minRadius: 1.05,
  /** Altitude (ER) over which speed and turn rate ramp up to full. */
  proximityRamp: 0.35,
  /** Speed never reaches zero, so you can always crawl off the surface. */
  proximityFloor: 0.05,
  /** Longest step integrated in one frame (s), so a stalled tab cannot tunnel. */
  maxStepSec: 0.05,
  /** Pitch stops this close (|forward·up|) to straight up/down. */
  maxPitchDot: 0.998,
} as const;

export { GEAR_COUNT };

/** Deadzone + sign-preserving exponent curve for one stick axis. */
export function curve(v: number): number {
  if (Math.abs(v) < FLIGHT.deadzone) return 0;
  return Math.sign(v) * Math.pow(Math.abs(v), FLIGHT.exponent);
}

/** Deadzone only, linear, for triggers: travel maps 1:1 to speed. */
export function triggerLinear(v: number): number {
  return v < FLIGHT.deadzone ? 0 : v;
}

/** Next gear, clamped to the table. */
export function shiftGear(gear: number, delta: number): number {
  return Math.max(0, Math.min(GEAR_COUNT - 1, gear + delta));
}

/** Gear speed in scene units per second. */
export function gearUnitsPerSec(gear: number): number {
  return FLIGHT.gearsMps[gear] / FLIGHT.earthRadiusM;
}

/** Speed and turn scale near the surface: slow down close to Earth, full speed above the ramp. */
export function proximityScales(cameraDistance: number): { speed: number; turn: number } {
  const t = Math.max(0, Math.min(1, (cameraDistance - FLIGHT.minRadius) / FLIGHT.proximityRamp));
  return { speed: FLIGHT.proximityFloor + (1 - FLIGHT.proximityFloor) * t, turn: 0.5 + 0.5 * t };
}

/** Movement intent in the camera's frame. x strafe (right +), z forward (+), vert world up (+). */
export interface MoveIntent {
  x: number;
  z: number;
  vert: number;
}

/**
 * Clamp intent: the stick plane (strafe + vertical) to length 1 so diagonals are
 * not faster; forward/back to ±2 (the triggers' dash headroom).
 */
export function clampIntent(i: MoveIntent): MoveIntent {
  const planar = Math.hypot(i.x, i.vert);
  const k = planar > 1 ? 1 / planar : 1;
  return { x: i.x * k, vert: i.vert * k, z: Math.max(-2, Math.min(2, i.z)) };
}

const _right = new THREE.Vector3();
const _afterYaw = new THREE.Vector3();

/**
 * Right vector for a forward direction and world up. Falls back to the camera's
 * own right axis when looking (almost) straight along up, where forward × up
 * is degenerate. Writes `out`, returns it.
 */
export function rightVector(
  forward: THREE.Vector3,
  up: THREE.Vector3,
  cameraQuaternion: THREE.Quaternion,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.copy(forward).cross(up);
  if (out.lengthSq() < 1e-8) return out.set(1, 0, 0).applyQuaternion(cameraQuaternion).normalize();
  return out.normalize();
}

/**
 * Inertia state: look speeds and velocity glide toward their targets each step.
 * One instance per FlyController.
 */
export class FlightModel {
  readonly velocity = new THREE.Vector3();
  yawSpeed = 0;
  pitchSpeed = 0;
  private readonly targetVel = new THREE.Vector3();

  /**
   * Turn the view. `lookX/lookY` are already scaled stick/key values (right/down +).
   * Rotates `forward` in place (yaw about `up`, then pitch about the right axis),
   * refusing pitch that would pass straight up/down. Returns false when idle.
   */
  stepLook(
    lookX: number,
    lookY: number,
    dt: number,
    turnScale: number,
    forward: THREE.Vector3,
    up: THREE.Vector3,
    cameraQuaternion: THREE.Quaternion,
  ): boolean {
    const rate = FLIGHT.lookSpeed * turnScale * dt;
    const k = Math.min(1, FLIGHT.lookDamping * dt);
    this.yawSpeed += (-lookX * rate - this.yawSpeed) * k;
    this.pitchSpeed += (-lookY * rate - this.pitchSpeed) * k;
    if (Math.abs(this.yawSpeed) < 1e-6 && Math.abs(this.pitchSpeed) < 1e-6) return false;

    forward.applyAxisAngle(up, this.yawSpeed);
    rightVector(forward, up, cameraQuaternion, _right);
    _afterYaw.copy(forward);
    forward.applyAxisAngle(_right, this.pitchSpeed).normalize();
    if (Math.abs(forward.dot(up)) > FLIGHT.maxPitchDot) {
      forward.copy(_afterYaw); // keep the yaw, drop the pitch that would flip over the pole
      this.pitchSpeed = 0;
    }
    return true;
  }

  /**
   * Glide velocity toward the intent and return this frame's displacement in
   * `out`, or null when idle or when the step would go deeper into the surface
   * clamp (the glide is killed so you bump the floor instead of tunnelling).
   */
  stepMove(
    intent: MoveIntent,
    gear: number,
    speedScale: number,
    dt: number,
    position: THREE.Vector3,
    forward: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
    out: THREE.Vector3,
  ): THREE.Vector3 | null {
    const i = clampIntent(intent);
    const max = gearUnitsPerSec(gear) * speedScale;
    this.targetVel
      .set(0, 0, 0)
      .addScaledVector(right, i.x)
      .addScaledVector(forward, i.z)
      .addScaledVector(up, i.vert)
      .multiplyScalar(max);
    this.velocity.lerp(this.targetVel, Math.min(1, FLIGHT.moveDamping * dt));
    if (this.velocity.lengthSq() < 1e-16) return null;
    out.copy(this.velocity).multiplyScalar(Math.min(dt, FLIGHT.maxStepSec));
    const nx = position.x + out.x;
    const ny = position.y + out.y;
    const nz = position.z + out.z;
    // Only block steps that go deeper: below the clamp (e.g. after unfollowing a
    // very low object) you can still climb out.
    const nr = Math.hypot(nx, ny, nz);
    if (nr < FLIGHT.minRadius && nr < position.length()) {
      this.velocity.set(0, 0, 0);
      return null;
    }
    return out;
  }

  /** Stop all motion (leaving free flight, or a window blur). */
  reset(): void {
    this.velocity.set(0, 0, 0);
    this.yawSpeed = 0;
    this.pitchSpeed = 0;
  }
}
