import * as THREE from 'three';
import { easeInOutCubic } from '../easing';


export const HOME_POSITION = new THREE.Vector3(0, 1.5, 3.5);
export const HOME_TARGET = new THREE.Vector3(0, 0, 0);

interface AnimState {
  startTime: number;
  duration: number;
  startCamPos: THREE.Vector3;
  startTarget: THREE.Vector3;
}

/**
 * Handles cinematic camera animations (fly-to-satellite, return-to-home)
 * and continuous satellite tracking (follow mode).
 *
 * Does NOT own or modify OrbitControls — the Engine manages controls.enabled
 * and decides when to call controls.update().
 */
export class CameraAnimator {
  private readonly camera: THREE.PerspectiveCamera;
  private anim: AnimState | null = null;
  private readonly radialDir = new THREE.Vector3();
  private readonly joyrideForward = new THREE.Vector3(0, 1, 0);
  private readonly joyrideLookDir = new THREE.Vector3(0, 1, 0);
  private readonly joyrideYawRight = new THREE.Vector3(1, 0, 0);
  private readonly joyrideYawQuat = new THREE.Quaternion();
  private readonly joyridePitchQuat = new THREE.Quaternion();
  private readonly joyrideSmoothedForward = new THREE.Vector3(0, 1, 0);
  private joyrideSmoothedValid = false;
  private joyrideYawRad = 0;
  private joyridePitchRad = 0;

  /** Radial offset distance for follow mode. Computed by flyTo(). */
  followOffsetDist = 0.15;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  /** Start a fly-to-satellite animation (2 s). */
  flyTo(satPos: THREE.Vector3, currentTarget: THREE.Vector3): void {
    const altitude = satPos.length() - 1.0;
    this.followOffsetDist = Math.min(Math.max(altitude * 0.3 + 0.05, 0.06), 2.0);
    this.anim = {
      startTime: performance.now(),
      duration: 2000,
      startCamPos: this.camera.position.clone(),
      startTarget: currentTarget.clone(),
    };
  }

  /** Start a smooth return-to-home animation (1.5 s). */
  returnToHome(currentTarget: THREE.Vector3): void {
    this.anim = {
      startTime: performance.now(),
      duration: 1500,
      startCamPos: this.camera.position.clone(),
      startTarget: currentTarget.clone(),
    };
  }

  /**
   * Advance the current animation one frame.
   * Sets camera.position, writes the interpolated look-at target to `outTarget`,
   * and calls camera.lookAt.
   * @returns true when the animation has finished.
   */
  updateAnim(endCamPos: THREE.Vector3, endTarget: THREE.Vector3, outTarget: THREE.Vector3): boolean {
    if (!this.anim) return true;

    const t = Math.min((performance.now() - this.anim.startTime) / this.anim.duration, 1.0);
    const ease = easeInOutCubic(t);

    this.camera.position.lerpVectors(this.anim.startCamPos, endCamPos, ease);
    outTarget.lerpVectors(this.anim.startTarget, endTarget, ease);
    this.camera.lookAt(outTarget);

    if (t >= 1.0) {
      this.anim = null;
      return true;
    }
    return false;
  }

  /**
   * Follow a satellite. Camera stays radially above (away from Earth center).
   * Writes the satellite position to `outTarget` for OrbitControls sync.
   */
  updateFollow(satPos: THREE.Vector3, outTarget: THREE.Vector3): void {
    this.copyRadialFallback(satPos, this.radialDir);
    this.camera.position.copy(satPos).addScaledVector(this.radialDir, this.followOffsetDist);
    outTarget.copy(satPos);
    this.camera.lookAt(satPos);
  }

  /** Seed look target while flying into joyride mode (camera-at-object). */
  getJoyrideEntryTarget(objectPos: THREE.Vector3, objectVel: THREE.Vector3, outTarget: THREE.Vector3): void {
    this.copyRadialFallback(objectPos, this.radialDir);
    this.pickJoyrideForward(objectPos, objectVel, this.joyrideForward);
    if (!this.joyrideSmoothedValid) {
      this.joyrideSmoothedForward.copy(this.joyrideForward);
      this.joyrideSmoothedValid = true;
    }
    outTarget.copy(objectPos).addScaledVector(this.joyrideForward, this.getJoyrideLookAheadDistance(objectPos.length()));
  }

  /**
   * Joyride mode: camera rides with the object and lets the user free-look.
   * Orientation basis follows velocity with robust fallback and smoothing.
   */
  updateJoyride(objectPos: THREE.Vector3, objectVel: THREE.Vector3, outTarget: THREE.Vector3): void {
    this.copyRadialFallback(objectPos, this.radialDir);
    this.pickJoyrideForward(objectPos, objectVel, this.joyrideForward);

    if (!this.joyrideSmoothedValid) {
      this.joyrideSmoothedForward.copy(this.joyrideForward);
      this.joyrideSmoothedValid = true;
    } else {
      this.joyrideSmoothedForward.lerp(this.joyrideForward, 0.2);
      const lenSq = this.joyrideSmoothedForward.lengthSq();
      if (lenSq > 1e-10) {
        this.joyrideSmoothedForward.multiplyScalar(1 / Math.sqrt(lenSq));
      } else {
        this.joyrideSmoothedForward.copy(this.joyrideForward);
      }
    }

    // Yaw around the STABLE radial-up (not the frame-derived up)
    // This is the key fix — joyrideUp was wobbling with velocity changes
    this.joyrideYawQuat.setFromAxisAngle(this.radialDir, this.joyrideYawRad);

    // Yawed forward
    const yawedForward = this.joyrideSmoothedForward.clone().applyQuaternion(this.joyrideYawQuat);

    // Pitch axis = yawedForward × radialDir, normalized
    this.joyrideYawRight.crossVectors(yawedForward, this.radialDir);
    const rightLen = this.joyrideYawRight.length();
    if (rightLen > 1e-6) {
      this.joyrideYawRight.multiplyScalar(1 / rightLen);
    } else {
      // forward is nearly parallel to radialDir — use world X as fallback
      this.joyrideYawRight.set(1, 0, 0);
    }

    this.joyridePitchQuat.setFromAxisAngle(this.joyrideYawRight, this.joyridePitchRad);

    this.joyrideLookDir.copy(yawedForward).applyQuaternion(this.joyridePitchQuat);
    const lookLen = this.joyrideLookDir.length();
    if (lookLen > 1e-10) {
      this.joyrideLookDir.multiplyScalar(1 / lookLen);
    } else {
      this.joyrideLookDir.copy(this.joyrideSmoothedForward);
    }

    this.camera.position.copy(objectPos).addScaledVector(
      this.radialDir,
      this.getJoyrideSeatOffsetDistance(objectPos.length()),
    );
    outTarget.copy(this.camera.position).addScaledVector(
      this.joyrideLookDir,
      this.getJoyrideLookAheadDistance(objectPos.length()),
    );
    this.camera.lookAt(outTarget);
  }

  addJoyrideLookInput(deltaYawRad: number, deltaPitchRad: number): void {
    this.joyrideYawRad = this.wrapAngle(this.joyrideYawRad + deltaYawRad);
    const maxPitch = THREE.MathUtils.degToRad(85);
    this.joyridePitchRad = THREE.MathUtils.clamp(
      this.joyridePitchRad + deltaPitchRad,
      -maxPitch,
      maxPitch,
    );
  }

  resetJoyrideState(): void {
    this.joyrideSmoothedValid = false;
    this.joyrideYawRad = 0;
    this.joyridePitchRad = 0;
  }

  private getJoyrideLookAheadDistance(objectRadiusEr: number): number {
    return Math.min(Math.max(objectRadiusEr * 0.04, 0.12), 4.0);
  }

  private getJoyrideSeatOffsetDistance(objectRadiusEr: number): number {
    return Math.min(Math.max(objectRadiusEr * 0.00008, 0.00045), 0.004);
  }

  private pickJoyrideForward(
    objectPos: THREE.Vector3,
    objectVel: THREE.Vector3,
    outForward: THREE.Vector3,
  ): void {
    const velLenSq = objectVel.lengthSq();
    if (velLenSq > 1e-12) {
      outForward.copy(objectVel).multiplyScalar(1 / Math.sqrt(velLenSq));
      return;
    }
    if (this.joyrideSmoothedValid) {
      outForward.copy(this.joyrideSmoothedForward);
      return;
    }
    this.copyRadialFallback(objectPos, outForward);
  }

  private copyRadialFallback(source: THREE.Vector3, outDir: THREE.Vector3): void {
    const lenSq = source.lengthSq();
    if (lenSq <= 1e-10) {
      outDir.set(0, 1, 0);
      return;
    }
    outDir.copy(source).multiplyScalar(1 / Math.sqrt(lenSq));
  }

  private wrapAngle(radians: number): number {
    const twoPi = Math.PI * 2;
    let wrapped = radians % twoPi;
    if (wrapped > Math.PI) wrapped -= twoPi;
    if (wrapped < -Math.PI) wrapped += twoPi;
    return wrapped;
  }

  /** Cancel any active animation. */
  cancel(): void {
    this.anim = null;
  }
}
