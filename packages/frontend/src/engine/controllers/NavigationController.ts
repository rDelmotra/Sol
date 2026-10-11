import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CameraAnimator, HOME_POSITION, HOME_TARGET } from './CameraAnimator';
import { ObserverSkyController } from './ObserverSkyController';
import { useStore, type TrackingStyle } from '../../store/useStore';
import { dsoIndexOf } from '../../data/dso-index';
import type { TrackingSource } from './TrackingSource';
import type { GeodeticObserver } from '../../data/types';
import { gmst } from '@orbitwatch/orbital-core';
import { simClock } from '../../time/SimClock';
import { sceneRayToGeodetic } from '../scene/ground-pick';

/** Unfollow pull-back: ease the camera out along a fixed axis to the orbit floor. */
interface UnfollowAnim {
  startTime: number;
  duration: number;
  /** Camera's backward axis at press time; fixed so the camera slides straight back. */
  backward: THREE.Vector3;
  startDist: number;
  endDist: number;
}

const UNFOLLOW_MS = 450;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

interface NavigationCallbacks {
  /** Tell the input layer to drop any in-progress joyride free-look state. */
  onCancelJoyrideLook: () => void;
}

/**
 * Owns the camera state machine (free / flying / following / returning) plus the
 * select / fly-to / joyride / reset / observer-sky behaviours that drive it.
 *
 * Reads per-frame object positions/velocities through a {@link TrackingSource} so it
 * never imports the renderers or worker clients. Registers exactly one store
 * subscription (camera-mode transitions); the per-frame `update()` only reads
 * `useStore.getState()` snapshots.
 */
export class NavigationController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly source: TrackingSource;
  private readonly callbacks: NavigationCallbacks;
  private readonly cameraController: CameraAnimator;
  private readonly observerSky: ObserverSkyController;

  private arrivalTime = -1; // performance.now() when camera arrived; -1 = none
  private returnEndPos: THREE.Vector3 | null = null;
  private returnEndTarget: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
  private useHardReset = false;
  private dragExitedFollowingFromInput = false;
  private cameraModeUnsub: (() => void) | null = null;
  private unfollowAnim: UnfollowAnim | null = null;
  /** Camera pose when the ground rig was first entered; restored by the one exit path. */
  private savedPose: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;

  private readonly trackingRadialDir = new THREE.Vector3();
  private readonly trackingEndCamPos = new THREE.Vector3();
  private readonly joyrideEntryTarget = new THREE.Vector3();
  private readonly trackingVelocity = new THREE.Vector3();
  private readonly trackingPos = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    source: TrackingSource,
    callbacks: NavigationCallbacks,
  ) {
    this.camera = camera;
    this.controls = controls;
    this.source = source;
    this.callbacks = callbacks;
    this.cameraController = new CameraAnimator(camera);
    this.observerSky = new ObserverSkyController(camera, controls, (headingRad) => {
      useStore.getState().setObserverHeadingRad(headingRad);
    });

    // Centralized camera mode transitions
    let prevCameraMode = useStore.getState().cameraMode;
    this.cameraModeUnsub = useStore.subscribe((state) => {
      if (state.cameraMode === prevCameraMode) return;
      prevCameraMode = state.cameraMode;

      // The observer-sky rig only drives the camera in 'free'. Leaving it (fly-to /
      // follow / joyride / return) hands the camera off, so release the rig's lens +
      // world-up here — otherwise e.g. joyride inherits the dome's wide FOV. The rig
      // is re-established below when the camera returns to 'free' (if still in an
      // observer mode), so a dome → joyride → reset round-trip restores the dome.
      if (state.cameraMode !== 'free' && this.observerSky.isActive()) {
        this.observerSky.exit();
      }

      // Any transition to 'free': cancel animation, re-enable controls
      if (state.cameraMode === 'free') {
        this.cameraController.cancel();
        this.cameraController.resetJoyrideState();
        this.controls.enabled = true;
        this.callbacks.onCancelJoyrideLook();
        this.arrivalTime = -1;

        if (this.dragExitedFollowingFromInput) {
          this.dragExitedFollowingFromInput = false;
        } else if (this.returnEndPos) {
          this.controls.target.set(0, 0, 0);
          this.returnEndPos = null;
        }

        // Still on the ground? Re-establish the observer-sky rig (re-pins the eye +
        // its FOV) so it survives a joyride/fly-to round-trip.
        if (state.vantage === 'ground' && state.observerLocation) {
          this.observerSky.enter(state.observerLocation);
        }
      }

      // Entering 'returning': disable controls and start return animation
      if (state.cameraMode === 'returning') {
        this.cameraController.cancel();
        this.cameraController.resetJoyrideState();
        this.controls.enabled = false;
        this.callbacks.onCancelJoyrideLook();
        this.arrivalTime = -1;

        this.cameraController.returnToHome(this.controls.target);

        if (this.useHardReset) {
          this.returnEndPos = HOME_POSITION.clone();
          this.returnEndTarget.copy(HOME_TARGET);
          this.useHardReset = false;
        } else {
          const dir = this.camera.position.clone().normalize();
          const currentDistance = this.camera.position.length();
          const targetDist = Math.max(currentDistance, HOME_POSITION.length());
          this.returnEndPos = dir.multiplyScalar(targetDist);
          this.returnEndTarget.set(0, 0, 0);
        }
      }

      if (state.cameraMode === 'flying') {
        this.controls.enabled = false;
      }

      if (state.cameraMode === 'following') {
        this.controls.enabled = false;
      }
    });
  }

  /** performance.now() when the camera last arrived at a target; -1 = none. */
  getArrivalTime(): number {
    return this.arrivalTime;
  }

  /** Forward a joyride free-look delta into the camera animation helper. */
  addJoyrideLookInput(deltaYawRad: number, deltaPitchRad: number): void {
    this.cameraController.addJoyrideLookInput(deltaYawRad, deltaPitchRad);
  }

  /** Input layer reports a drag that should exit follow without snapping the target. */
  notifyDragExitedFollowing(): void {
    this.dragExitedFollowingFromInput = true;
  }

  /** Per-frame camera update. `uT` is the GPU-side interpolation factor for TLE positions. */
  update(uT: number): void {
    const store = useStore.getState();
    const cameraMode = store.cameraMode;
    const trackingStyle = store.trackingStyle;
    const selectedIdx = store.selectedIndex;
    const selectedDso = store.selectedDso;

    // Something else changed the mode mid pull-back (e.g. reset) — drop it.
    if (this.unfollowAnim && cameraMode !== 'following' && cameraMode !== 'flying') {
      this.unfollowAnim = null;
    }

    if (cameraMode === 'free') {
      // Observer-sky rig (visual / dome modes): eye pinned to the observer, gaze
      // driven by drag. Delegated to ObserverSkyController, which re-anchors the
      // eye each frame as the Earth rotates underneath.
      if (this.observerSky.isActive() && store.observerLocation) {
        this.observerSky.update(store.observerLocation);
      } else {
        this.controls.update();
      }

    } else if (cameraMode === 'flying' && selectedIdx !== null) {
      // TLE fly-to
      if (this.source.getTleKinematics(selectedIdx, uT, this.trackingPos, this.trackingVelocity)) {
        let endCamPos: THREE.Vector3;
        let endTarget: THREE.Vector3;
        if (trackingStyle === 'joyride') {
          endCamPos = this.trackingPos;
          this.cameraController.getJoyrideEntryTarget(this.trackingPos, this.trackingVelocity, this.joyrideEntryTarget);
          endTarget = this.joyrideEntryTarget;
        } else {
          this.trackingRadialDir.copy(this.trackingPos).normalize();
          this.trackingEndCamPos.copy(this.trackingPos).addScaledVector(
            this.trackingRadialDir,
            this.cameraController.followOffsetDist,
          );
          endCamPos = this.trackingEndCamPos;
          endTarget = this.trackingPos;
        }
        const done = this.cameraController.updateAnim(endCamPos, endTarget, this.controls.target);
        if (done) {
          store.setCameraMode('following');
          this.arrivalTime = performance.now();
        }
        this.applyUnfollowPullback();
      }

    } else if (cameraMode === 'flying' && selectedDso !== null) {
      // DSO fly-to
      const dsoIndex = dsoIndexOf(store.dsoObjects, selectedDso.dsoId);
      if (this.source.getDsoKinematics(dsoIndex, this.trackingPos, this.trackingVelocity)) {
        let endCamPos: THREE.Vector3;
        let endTarget: THREE.Vector3;
        if (trackingStyle === 'joyride') {
          endCamPos = this.trackingPos;
          this.cameraController.getJoyrideEntryTarget(this.trackingPos, this.trackingVelocity, this.joyrideEntryTarget);
          endTarget = this.joyrideEntryTarget;
        } else {
          this.trackingRadialDir.copy(this.trackingPos).normalize();
          this.trackingEndCamPos.copy(this.trackingPos).addScaledVector(
            this.trackingRadialDir,
            this.cameraController.followOffsetDist,
          );
          endCamPos = this.trackingEndCamPos;
          endTarget = this.trackingPos;
        }
        const done = this.cameraController.updateAnim(endCamPos, endTarget, this.controls.target);
        if (done) {
          store.setCameraMode('following');
          this.arrivalTime = performance.now();
        }
        this.applyUnfollowPullback();
      } else {
        // No ephemeris yet — stay in free until data arrives
        store.setCameraMode('free');
      }

    } else if (cameraMode === 'following' && selectedIdx !== null) {
      // TLE follow
      if (this.source.getTleKinematics(selectedIdx, uT, this.trackingPos, this.trackingVelocity)) {
        if (trackingStyle === 'joyride') {
          this.cameraController.updateJoyride(this.trackingPos, this.trackingVelocity, this.controls.target);
        } else {
          this.cameraController.updateFollow(this.trackingPos, this.controls.target);
        }
        this.applyUnfollowPullback();
      }

    } else if (cameraMode === 'following' && selectedDso !== null) {
      // DSO follow
      const dsoIndex = dsoIndexOf(store.dsoObjects, selectedDso.dsoId);
      if (this.source.getDsoKinematics(dsoIndex, this.trackingPos, this.trackingVelocity)) {
        if (trackingStyle === 'joyride') {
          this.cameraController.updateJoyride(this.trackingPos, this.trackingVelocity, this.controls.target);
        } else {
          this.cameraController.updateFollow(this.trackingPos, this.controls.target);
        }
        this.applyUnfollowPullback();
      }

    } else if (cameraMode === 'returning') {
      const done = this.cameraController.updateAnim(
        this.returnEndPos || HOME_POSITION, this.returnEndTarget, this.controls.target,
      );
      if (done) {
        store.setCameraMode('free');
      }
    }
  }

  selectByIndex(index: number): void {
    const obj = this.source.getTleObject(index);
    if (index < 0 || index >= this.source.getTleCount() || !obj) return;

    const altitudeKm = this.source.getTleAltitudeKm(index);
    const store = useStore.getState();

    const isTracking = store.cameraMode === 'flying' || store.cameraMode === 'following';
    if (isTracking && store.selectedIndex !== null && store.selectedIndex !== index) {
      store.setSelectedSatellite(index, obj, Math.round(altitudeKm));
      const uT = this.source.getInterpolationFactor();
      this.source.getTleKinematics(index, uT, this.trackingPos, this.trackingVelocity);
      if (store.trackingStyle === 'joyride') {
        this.cameraController.resetJoyrideState();
      }
      this.arrivalTime = -1;
      this.cameraController.flyTo(this.trackingPos, this.controls.target);
      store.setCameraMode('flying');
      return;
    }

    if (store.cameraMode !== 'free' && store.selectedIndex !== index) {
      store.setCameraMode('free');
    }

    store.setSelectedSatellite(index, obj, Math.round(altitudeKm));
  }

  selectDsoByIndex(dsoIndex: number): void {
    const store = useStore.getState();
    const dso = store.dsoObjects[dsoIndex];
    if (!dso) return;

    if (store.cameraMode !== 'free') {
      store.setCameraMode('free');
    }

    store.setSelectedDso(dso);
  }

  flyToSatellite(index: number, style: TrackingStyle = 'follow'): void {
    if (index < 0 || index >= this.source.getTleCount() || !this.source.isReady()) return;

    let store = useStore.getState();
    if ((store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedIndex === index
      && store.trackingStyle === style) return;

    if (store.selectedIndex !== index) {
      this.selectByIndex(index);
    }

    store = useStore.getState();
    if (store.selectedIndex !== index) return;
    if (store.trackingStyle !== style) {
      store.setTrackingStyle(style);
    }

    const uT = this.source.getInterpolationFactor();
    this.source.getTleKinematics(index, uT, this.trackingPos, this.trackingVelocity);

    if (style === 'joyride') {
      this.cameraController.resetJoyrideState();
    }
    this.arrivalTime = -1;
    this.cameraController.flyTo(this.trackingPos, this.controls.target);
    store.setCameraMode('flying');
  }

  joyrideSatellite(index: number): void {
    this.flyToSatellite(index, 'joyride');
  }

  flyToDso(dsoId: string, style: TrackingStyle = 'follow'): void {
    let store = useStore.getState();
    const dsoIndex = dsoIndexOf(store.dsoObjects, dsoId);
    if (!this.source.getDsoKinematics(dsoIndex, this.trackingPos, this.trackingVelocity)) return;

    if ((store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedDso?.dsoId === dsoId
      && store.trackingStyle === style) return;

    if (store.selectedDso?.dsoId !== dsoId) {
      store.setSelectedDso(store.dsoObjects[dsoIndex]);
    }

    store = useStore.getState();
    if (store.selectedDso?.dsoId !== dsoId) return;
    if (store.trackingStyle !== style) {
      store.setTrackingStyle(style);
    }

    // Re-read the position after the (possible) selection change above.
    this.source.getDsoKinematics(dsoIndex, this.trackingPos, this.trackingVelocity);
    if (style === 'joyride') {
      this.cameraController.resetJoyrideState();
    }
    this.arrivalTime = -1;
    this.cameraController.flyTo(this.trackingPos, this.controls.target);
    store.setCameraMode('flying');
  }

  joyrideDso(dsoId: string): void {
    this.flyToDso(dsoId, 'joyride');
  }

  /**
   * Drop tracking and go free from where the camera is (pad B). Follow and
   * joyride sit far inside OrbitControls' minDistance; handing over as-is would
   * snap the camera out in one frame. So inside minDistance the distance eases
   * out over {@link UNFOLLOW_MS} along the camera's own backward axis while the
   * target keeps tracking the live object, then the mode flips to free.
   * No-op unless following/flying, or mid pull-back.
   */
  unfollow(): void {
    const store = useStore.getState();
    if (store.cameraMode !== 'following' && store.cameraMode !== 'flying') return;
    if (this.unfollowAnim) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const minDist = this.controls.minDistance;
    if (dist >= minDist) {
      this.finishUnfollow();
      return;
    }
    this.unfollowAnim = {
      startTime: performance.now(),
      duration: UNFOLLOW_MS,
      backward: this.camera.getWorldDirection(new THREE.Vector3()).negate(),
      startDist: dist,
      endDist: minDist,
    };
  }

  /** Re-seat the camera along the frozen axis from this frame's live target. */
  private applyUnfollowPullback(): void {
    const anim = this.unfollowAnim;
    if (!anim) return;
    const t = Math.min((performance.now() - anim.startTime) / anim.duration, 1);
    const distance = THREE.MathUtils.lerp(anim.startDist, anim.endDist, smoothstep(t));
    this.camera.position.copy(this.controls.target).addScaledVector(anim.backward, distance);
    this.camera.lookAt(this.controls.target);
    if (t >= 1) this.finishUnfollow();
  }

  private finishUnfollow(): void {
    this.unfollowAnim = null;
    this.controls.enabled = true;
    this.dragExitedFollowingFromInput = true; // keep the target where it is
    useStore.getState().setCameraMode('free');
  }

  /**
   * Land where the view centre meets the ground: cast the camera's forward ray
   * onto the WGS84 ellipsoid and stand there (ground vantage). On a miss, reuse
   * the existing observer location unchanged (keeps a GPS altitude); with none,
   * do nothing. Returns whether it landed. Naming the place is the UI's job.
   */
  landWhereLooking(): boolean {
    const store = useStore.getState();
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const pick = sceneRayToGeodetic(this.camera.position, direction, gmst(simClock.now()));
    const landing = pick ? { lat: pick.latDeg, lon: pick.lonDeg, alt: 0 } : store.observerLocation;
    if (!landing) return false;
    if (pick) {
      store.setObserverPlaceName(null); // the old name describes the old point
      store.setObserverLocation(landing);
    }
    store.setVantage('ground');
    return true;
  }

  /** Take off: back to orbit. Same exit path as the ORBIT control (see exitObserverSky). */
  takeOff(): void {
    useStore.getState().setVantage('orbit');
  }

  /** L / pad D-pad ▼: land if in orbit, take off if on the ground. */
  toggleLanding(): void {
    if (useStore.getState().vantage === 'ground') this.takeOff();
    else this.landWhereLooking();
  }

  resetCamera(): void {
    const store = useStore.getState();
    this.unfollowAnim = null;
    this.useHardReset = true;
    if (store.cameraMode !== 'returning') {
      store.setCameraMode('returning');
    } else {
      this.returnEndPos = HOME_POSITION.clone();
      this.returnEndTarget.copy(HOME_TARGET);
      this.cameraController.returnToHome(this.controls.target);
      this.useHardReset = false;
    }
  }

  /** Enter the observer-sky rig for ground vantage (eye pinned + alt-az look). */
  enterObserverSky(loc: GeodeticObserver): void {
    const store = useStore.getState();
    this.savePoseOnce();
    if (store.cameraMode !== 'free') {
      // The cameraMode → 'free' transition re-establishes the rig (see the sub
      // above), reading the now-current vantage + location — so don't also
      // enter here, or it would double-fire.
      store.setCameraMode('free');
      return;
    }
    this.cameraController.cancel();
    this.arrivalTime = -1;
    this.returnEndPos = null;
    this.observerSky.enter(loc);
  }

  /** Remember the orbit pose the first time the ground is entered (not on re-seeds). */
  private savePoseOnce(): void {
    if (this.savedPose) return;
    this.savedPose = { position: this.camera.position.clone(), target: this.controls.target.clone() };
  }

  /**
   * The ONE way off the ground (vantage → orbit, from the ORBIT control or take-off).
   * Restores the orbit pose saved on landing; with none saved, glides home.
   */
  exitObserverSky(): void {
    this.observerSky.exit();
    const pose = this.savedPose;
    this.savedPose = null;
    if (!pose) {
      this.resetCamera();
      return;
    }
    const store = useStore.getState();
    if (store.cameraMode !== 'free') store.setCameraMode('free');
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    this.controls.enabled = true;
  }

  /** Forward a dome alt-az look delta (radians) from the input layer into the rig. */
  addDomeLookInput(deltaAzRad: number, deltaElRad: number): void {
    this.observerSky.addLookInput(deltaAzRad, deltaElRad);
  }

  /** Forward a dome scroll/pinch zoom factor (<1 zoom in, >1 zoom out) into the rig. */
  addDomeZoom(factor: number): void {
    this.observerSky.zoom(factor);
  }

  dispose(): void {
    this.cameraModeUnsub?.();
    this.cameraModeUnsub = null;
  }
}
