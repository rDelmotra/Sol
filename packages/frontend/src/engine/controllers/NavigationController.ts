import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CameraAnimator, HOME_POSITION, HOME_TARGET } from './CameraAnimator';
import { ObserverSkyController } from './ObserverSkyController';
import { useStore, isObserverMode, type TrackingStyle, type VisibilityMode } from '../../store/useStore';
import { dsoIndexOf } from '../../data/dso-index';
import type { TrackingSource } from './TrackingSource';

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

        // Still in dome/visual? Re-establish the observer-sky rig (re-pins the eye +
        // its FOV) so it survives a joyride/fly-to round-trip.
        if (isObserverMode(state.visibilityMode) && state.observerLocation) {
          this.observerSky.enter(state.observerLocation, state.visibilityMode);
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

  resetCamera(): void {
    const store = useStore.getState();
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

  /** Enter the observer-sky rig for visual/dome mode (eye pinned + alt-az look). */
  enterObserverSky(loc: { lat: number; lon: number; alt: number }, mode: VisibilityMode): void {
    const store = useStore.getState();
    if (store.cameraMode !== 'free') {
      // The cameraMode → 'free' transition re-establishes the rig (see the sub
      // above), reading the now-current observer mode + location — so don't also
      // enter here, or it would double-fire.
      store.setCameraMode('free');
      return;
    }
    this.cameraController.cancel();
    this.arrivalTime = -1;
    this.returnEndPos = null;
    this.observerSky.enter(loc, mode);
  }

  /** Leave the observer-sky rig (mode → non-observer) and return the camera home. */
  exitObserverSky(): void {
    this.observerSky.exit();
    this.resetCamera();
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
