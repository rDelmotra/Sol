import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getObserverSceneAnchor } from '../scene/sky';
import { simClock } from '../SimClock';
import type { VisibilityMode } from '../../store/useStore';

type ObserverLoc = { lat: number; lon: number; alt: number };

/** Eye height above the observer's feet, in Earth radii (~16 m). */
const EYE_HEIGHT_ER = 0.0000025;
/**
 * Target **horizontal** FOV for the immersive dome (Star Walk-style); visual mode
 * keeps the default lens. Three.js `camera.fov` is vertical, so we derive the
 * vertical FOV from this target + the live aspect ratio (see {@link verticalFovForHorizontal}).
 * Kept moderate (not the full 90°): at 90° the cardinals 90° apart sit right at the
 * screen edges — the most `tan`-distorted zone — which makes the horizon markers
 * appear to taper/expand as you look around. A narrower span crops that periphery,
 * which is exactly why phone planetarium apps feel clean (the HUD compass strip
 * carries the wider directional context).
 */
const DOME_HFOV_DEG = 65;
/** Cap on the derived vertical FOV so very tall/portrait screens don't go fisheye. */
const DOME_VFOV_MAX_DEG = 100;
/** Scroll/pinch zoom range for the dome lens (horizontal FOV degrees). */
const DOME_HFOV_MIN_DEG = 18; // fully zoomed in (telescope-ish)
const DOME_HFOV_MAX_DEG = 90; // fully zoomed out (wide field)
const MIN_ELEVATION_RAD = THREE.MathUtils.degToRad(-5);
const MAX_ELEVATION_RAD = THREE.MathUtils.degToRad(89);
/** Initial gaze: facing north (az 0), tilted ~45° up the dome. */
const INITIAL_ELEVATION_RAD = THREE.MathUtils.degToRad(45);

/**
 * Earth's spin axis (celestial north pole) in the Three.js scene frame.
 * TEME +Z = (0,0,1) maps through the `frames.ts` swap `(x,z,-y)` → (0,1,0).
 */
const SCENE_NORTH_POLE = new THREE.Vector3(0, 1, 0);

/**
 * Owns the **observer-anchored alt-azimuth camera** shared by `visual` and `dome`
 * visibility modes — the planetarium rig. Mirrors how {@link CameraController} is a
 * focused camera helper owned by {@link NavigationController}: Nav delegates here.
 *
 * The eye is pinned at the observer's location (re-anchored every frame as the Earth
 * rotates under them); the user's drag only rotates the gaze (azimuth + elevation)
 * across the upper hemisphere, with `camera.up` locked to the local zenith so the
 * horizon stays level. OrbitControls are disabled while active — this rig replaces
 * them — and the original FOV is captured/restored around dome's wider FOV.
 */
export class ObserverSkyController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly originalFov: number;
  /** Published whenever the gaze heading changes (enter / drag) — drives the HUD compass. */
  private readonly onHeadingChange?: (headingRad: number) => void;

  private active = false;
  /** True while the wide dome lens is applied (mode === 'dome'); 'visual' keeps default. */
  private domeLens = false;
  /** Current dome **horizontal** FOV (degrees); driven by scroll/pinch zoom. */
  private domeHFovDeg = DOME_HFOV_DEG;
  /** Aspect the dome vertical FOV was last derived from; re-derived on change (resize/rotate). */
  private lastAspect = 0;
  private azimuth = 0; // radians, measured from North toward East
  private elevation = INITIAL_ELEVATION_RAD; // radians, 0 = horizon, +up = zenith

  // Per-frame scratch (no allocation in the rAF path).
  private readonly up = new THREE.Vector3();
  private readonly east = new THREE.Vector3();
  private readonly north = new THREE.Vector3();
  private readonly gaze = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    onHeadingChange?: (headingRad: number) => void,
  ) {
    this.camera = camera;
    this.controls = controls;
    this.originalFov = camera.fov;
    this.onHeadingChange = onHeadingChange;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Enter observer-sky: pin the eye, disable orbit, set FOV, seed the gaze. */
  enter(loc: ObserverLoc, mode: VisibilityMode): void {
    this.active = true;
    this.azimuth = 0;
    this.elevation = INITIAL_ELEVATION_RAD;
    this.domeHFovDeg = DOME_HFOV_DEG; // fresh entry starts at the default lens
    this.onHeadingChange?.(this.azimuth);
    this.controls.enabled = false;
    this.domeLens = mode === 'dome';
    if (this.domeLens) {
      this.applyDomeFov();
    } else {
      this.setFov(this.originalFov);
    }
    this.applyToCamera(loc);
  }

  /**
   * Leave observer-sky: restore the default FOV and world-up. Called both when the
   * user leaves dome/visual mode AND when the camera leaves the free view (fly-to /
   * joyride) — so those never inherit the dome lens or the tilted local-zenith up.
   * (Nav re-enables controls via its cameraMode machine.)
   */
  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.domeLens = false;
    this.setFov(this.originalFov);
    this.camera.up.set(0, 1, 0);
  }

  /** Rotate the gaze. `dAz`/`dEl` are radian deltas from the input layer. */
  addLookInput(dAz: number, dEl: number): void {
    if (!this.active) return;
    this.azimuth = wrapAngle(this.azimuth + dAz);
    this.elevation = THREE.MathUtils.clamp(
      this.elevation + dEl,
      MIN_ELEVATION_RAD,
      MAX_ELEVATION_RAD,
    );
    this.onHeadingChange?.(this.azimuth);
  }

  /**
   * Per-frame: re-anchor the eye to the (rotating) observer and re-apply the gaze.
   * Re-asserts `controls.enabled = false` so a return-from-fly-to (which flips it
   * back on via the cameraMode sub) can't leave OrbitControls fighting the rig.
   */
  update(loc: ObserverLoc): void {
    if (!this.active) return;
    this.controls.enabled = false;
    // Re-derive the dome's vertical FOV if the aspect changed (window resize /
    // device rotation). The setFov equality guard makes the steady state a no-op.
    if (this.domeLens && this.camera.aspect !== this.lastAspect) {
      this.applyDomeFov();
    }
    this.applyToCamera(loc);
  }

  private applyToCamera(loc: ObserverLoc): void {
    const anchor = getObserverSceneAnchor(loc.lat, loc.lon, loc.alt, simClock.date());
    this.up.copy(anchor.up);

    // Local East-North-Up basis. East ⟂ {spin axis, up}; North completes it.
    this.east.crossVectors(SCENE_NORTH_POLE, this.up);
    if (this.east.lengthSq() < 1e-8) {
      this.east.set(1, 0, 0); // observer at a pole — pick an arbitrary tangent
    }
    this.east.normalize();
    this.north.crossVectors(this.up, this.east).normalize();

    const cosEl = Math.cos(this.elevation);
    const sinEl = Math.sin(this.elevation);
    this.gaze
      .set(0, 0, 0)
      .addScaledVector(this.east, cosEl * Math.sin(this.azimuth))
      .addScaledVector(this.north, cosEl * Math.cos(this.azimuth))
      .addScaledVector(this.up, sinEl);

    this.eye.copy(anchor.position).addScaledVector(this.up, EYE_HEIGHT_ER);
    this.lookTarget.copy(this.eye).add(this.gaze);

    this.camera.up.copy(this.up);
    this.camera.position.copy(this.eye);
    this.camera.lookAt(this.lookTarget);
  }

  /**
   * Derive the vertical FOV from the dome's horizontal target + the camera's live
   * aspect (capped to avoid portrait fisheye) and apply it. Caches the aspect so
   * {@link update} only re-derives on change.
   */
  private applyDomeFov(): void {
    const aspect = this.camera.aspect;
    this.lastAspect = aspect;
    this.setFov(verticalFovForHorizontal(this.domeHFovDeg, aspect, DOME_VFOV_MAX_DEG));
  }

  /**
   * Scroll/pinch zoom — the Star Walk lens. `factor < 1` narrows the FOV (zoom in),
   * `factor > 1` widens it (zoom out); the horizontal FOV is clamped to
   * [{@link DOME_HFOV_MIN_DEG}, {@link DOME_HFOV_MAX_DEG}]. No-op outside dome mode.
   */
  zoom(factor: number): void {
    if (!this.active || !this.domeLens) return;
    this.domeHFovDeg = THREE.MathUtils.clamp(
      this.domeHFovDeg * factor,
      DOME_HFOV_MIN_DEG,
      DOME_HFOV_MAX_DEG,
    );
    this.applyDomeFov();
  }

  private setFov(fov: number): void {
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

/**
 * Convert a target horizontal FOV to the vertical FOV Three.js expects, for a given
 * aspect (width/height): `vFov = 2·atan(tan(hFov/2) / aspect)`, clamped to `maxVFovDeg`.
 * Keeps the horizontal span fixed across screen shapes (the Star Walk "cardinals at
 * the edges" feel) instead of letting a fixed vertical FOV inflate the horizontal one.
 */
function verticalFovForHorizontal(hFovDeg: number, aspect: number, maxVFovDeg: number): number {
  const hFovRad = THREE.MathUtils.degToRad(hFovDeg);
  const vFovRad = 2 * Math.atan(Math.tan(hFovRad / 2) / aspect);
  return Math.min(THREE.MathUtils.radToDeg(vFovRad), maxVFovDeg);
}

function wrapAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = radians % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}
