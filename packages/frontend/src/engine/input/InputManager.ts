import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SatelliteRenderer } from '../SatelliteRenderer';
import type { DsoRenderer } from '../DsoRenderer';
import type { GPUPicker } from '../GPUPicker';
import type { EnrichedTLEObject } from '../../data/types';
import { useStore } from '../../store/useStore';

// ── Constants ────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;
const CLUSTER_RADIUS_SQ = 0.0078 * 0.0078; // ~50 km in scene units, squared
const HOVER_THROTTLE_MS = 100;
/** Wheel zoom feel: FOV factor = exp(deltaY · k). Scroll up (deltaY<0) zooms in. */
const WHEEL_ZOOM_K = 0.0014;

// ── InputManager ─────────────────────────────────────────────────────────────

export class InputManager {
  private readonly canvas: HTMLCanvasElement;
  private readonly satelliteRenderer: SatelliteRenderer;
  // Nullable: a soft-failed (non-critical) DSO layer leaves no renderer.
  private readonly dsoRenderer: DsoRenderer | null;
  private readonly controls: OrbitControls;

  private readonly onSelectTle: (index: number) => void;
  private readonly onSelectDso: (dsoIndex: number) => void;
  private readonly onDeselect: () => void;
  private readonly onDragExitFollow: () => void;
  private readonly onJoyrideLookInput: (dx: number, dy: number) => void;
  private readonly onDomeLookInput: (dAz: number, dEl: number) => void;
  private readonly onDomeZoom: (factor: number) => void;

  private gpuPicker: GPUPicker | null = null;
  private catalogData: EnrichedTLEObject[] = [];
  private firstPositionReceived = false;

  private pointerDownPos: { x: number; y: number } | null = null;
  private joyrideLookPointerPos: { x: number; y: number } | null = null;
  private domeLookPointerPos: { x: number; y: number } | null = null;
  private lastHoverTime = 0;

  // Live pointers (by id) + last pinch separation — for two-finger dome zoom.
  private readonly activePointers = new Map<number, { x: number; y: number }>();
  private pinchPrevDist: number | null = null;

  constructor(
    deps: {
      canvas: HTMLCanvasElement;
      satelliteRenderer: SatelliteRenderer;
      dsoRenderer: DsoRenderer | null;
      controls: OrbitControls;
    },
    callbacks: {
      onSelectTle: (index: number) => void;
      onSelectDso: (dsoIndex: number) => void;
      onDeselect: () => void;
      onDragExitFollow: () => void;
      onJoyrideLookInput: (dx: number, dy: number) => void;
      onDomeLookInput: (dAz: number, dEl: number) => void;
      onDomeZoom: (factor: number) => void;
    },
  ) {
    this.canvas = deps.canvas;
    this.satelliteRenderer = deps.satelliteRenderer;
    this.dsoRenderer = deps.dsoRenderer;
    this.controls = deps.controls;

    this.onSelectTle = callbacks.onSelectTle;
    this.onSelectDso = callbacks.onSelectDso;
    this.onDeselect = callbacks.onDeselect;
    this.onDragExitFollow = callbacks.onDragExitFollow;
    this.onJoyrideLookInput = callbacks.onJoyrideLookInput;
    this.onDomeLookInput = callbacks.onDomeLookInput;
    this.onDomeZoom = callbacks.onDomeZoom;

    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    // Non-passive so we can preventDefault the page scroll while zooming the dome.
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Deferred — GPUPicker is created after catalog data loads. */
  setGpuPicker(picker: GPUPicker): void {
    this.gpuPicker = picker;
  }

  setCatalogData(data: EnrichedTLEObject[]): void {
    this.catalogData = data;
  }

  setFirstPositionReceived(v: boolean): void {
    this.firstPositionReceived = v;
  }

  /** Called by Engine's cameraModeUnsub when transitioning to 'free' or 'returning'. */
  cancelJoyrideLook(): void {
    this.joyrideLookPointerPos = null;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('wheel', this.handleWheel);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /** Dome lens active = free camera + dome mode + a known observer location. */
  private isDomeActive(state: ReturnType<typeof useStore.getState>): boolean {
    return (
      state.cameraMode === 'free' &&
      state.visibilityMode === 'dome' &&
      state.observerLocation !== null
    );
  }

  private syncPickerUniforms(): void {
    if (!this.gpuPicker) return;
    this.gpuPicker.syncUniforms(
      this.satelliteRenderer.material.uniforms.uT.value,
      this.satelliteRenderer.material.uniforms.uCameraDistance.value,
      this.satelliteRenderer.material.uniforms.uPixelRatio.value,
    );
  }

  /** Scroll wheel → dome FOV zoom (the Star Walk lens). No-op outside dome mode. */
  private handleWheel = (e: WheelEvent): void => {
    if (!this.isDomeActive(useStore.getState())) return;
    e.preventDefault(); // suppress page scroll while zooming the sky
    // Scroll up (deltaY < 0) narrows the FOV (factor < 1) → zoom in.
    this.onDomeZoom(Math.exp(e.deltaY * WHEEL_ZOOM_K));
  };

  private handlePointerDown = (e: PointerEvent): void => {
    const state = useStore.getState();

    // Track every active pointer so a second finger can drive pinch-zoom.
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.activePointers.size >= 2 && this.isDomeActive(state)) {
      // Second finger down in dome mode: start a pinch, cancel the one-finger pan.
      this.pinchPrevDist = this.currentPinchDist();
      this.domeLookPointerPos = null;
      this.pointerDownPos = null;
      return;
    }

    if (state.cameraMode === 'following' && state.trackingStyle === 'joyride') {
      this.joyrideLookPointerPos = { x: e.clientX, y: e.clientY };
      return;
    }
    // Sky-dome look: drag rotates the gaze (OrbitControls are disabled here). Also
    // record pointerDownPos so a tap still falls through to GPU pick/select below.
    if (state.cameraMode === 'free' && state.visibilityMode === 'dome' && state.observerLocation) {
      this.domeLookPointerPos = { x: e.clientX, y: e.clientY };
    }
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  /** Euclidean distance between the first two active pointers (pinch separation). */
  private currentPinchDist(): number | null {
    const pts = Array.from(this.activePointers.values());
    if (pts.length < 2) return null;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private handlePointerMove = (e: PointerEvent): void => {
    const state = useStore.getState();
    const mode = state.cameraMode;
    const isJoyrideFreeLook = mode === 'following' && state.trackingStyle === 'joyride';

    // Keep the live pointer position current for pinch math.
    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Two-finger pinch → dome FOV zoom (takes precedence over pan).
    if (this.pinchPrevDist !== null && this.activePointers.size >= 2) {
      if (!this.isDomeActive(state)) {
        this.pinchPrevDist = null;
      } else {
        const dist = this.currentPinchDist();
        if (dist && dist > 0 && this.pinchPrevDist > 0) {
          // Fingers apart (dist↑) → factor < 1 → narrow FOV → zoom in.
          this.onDomeZoom(this.pinchPrevDist / dist);
          this.pinchPrevDist = dist;
        }
        return;
      }
    }

    if (this.joyrideLookPointerPos) {
      if (!isJoyrideFreeLook) {
        this.joyrideLookPointerPos = null;
      } else {
        const dx = e.clientX - this.joyrideLookPointerPos.x;
        const dy = e.clientY - this.joyrideLookPointerPos.y;
        this.joyrideLookPointerPos = { x: e.clientX, y: e.clientY };
        if (dx !== 0 || dy !== 0) {
          this.onJoyrideLookInput(dx * 0.003, dy * 0.0025);
        }
        return;
      }
    }

    if (this.domeLookPointerPos) {
      const domeActive =
        mode === 'free' && state.visibilityMode === 'dome' && state.observerLocation !== null;
      if (!domeActive) {
        this.domeLookPointerPos = null;
      } else {
        const dx = e.clientX - this.domeLookPointerPos.x;
        const dy = e.clientY - this.domeLookPointerPos.y;
        this.domeLookPointerPos = { x: e.clientX, y: e.clientY };
        if (dx !== 0 || dy !== 0) {
          // Grab-the-sky: the sky follows the drag (content tracks the finger).
          this.onDomeLookInput(-dx * 0.0025, dy * 0.0025);
        }
        return;
      }
    }

    if (this.pointerDownPos && mode !== 'free') {
      const dx = e.clientX - this.pointerDownPos.x;
      const dy = e.clientY - this.pointerDownPos.y;
      if (dx * dx + dy * dy > 25) {
        if (mode === 'following') {
          // Aim OrbitControls at the currently followed object before handing back control
          const selectedIdx = state.selectedIndex;
          if (selectedIdx !== null) {
            const uT = this.satelliteRenderer.material.uniforms.uT.value as number;
            const satPos = this.satelliteRenderer.getInterpolatedPosition(selectedIdx, uT);
            this.controls.target.copy(satPos);
          } else {
            const dso = state.selectedDso;
            if (dso) {
              const dsoIndex = state.dsoObjects.findIndex((d) => d.dsoId === dso.dsoId);
              if (dsoIndex >= 0 && this.dsoRenderer) {
                this.controls.target.copy(this.dsoRenderer.getPositionAt(dsoIndex));
              }
            }
          }
          this.controls.enabled = true;
          this.onDragExitFollow();
        }
        useStore.getState().setCameraMode('free');
        this.pointerDownPos = null;
      }
    }

    const now = performance.now();
    if (now - this.lastHoverTime < HOVER_THROTTLE_MS) return;
    this.lastHoverTime = now;

    if (!this.gpuPicker || !this.firstPositionReceived) return;

    // Planetarium / empty catalog — nothing to pick; don't index an empty catalog.
    if (this.catalogData.length === 0) {
      this.canvas.style.cursor = '';
      useStore.getState().setHover(null);
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    this.syncPickerUniforms();
    const index = this.gpuPicker.pickSingle(screenX, screenY, rect.width, rect.height);

    if (index !== null && index < this.catalogData.length) {
      // TLE hover — UI-local store write
      this.canvas.style.cursor = 'pointer';
      useStore.getState().setHover(this.catalogData[index].name, e.clientX, e.clientY);
    } else if (index !== null && index >= this.catalogData.length) {
      // DSO hover — UI-local store write
      const dsoIndex = index - this.catalogData.length;
      const dsoObjects = useStore.getState().dsoObjects;
      if (dsoIndex < dsoObjects.length) {
        this.canvas.style.cursor = 'pointer';
        useStore.getState().setHover(dsoObjects[dsoIndex].name, e.clientX, e.clientY);
      }
    } else {
      this.canvas.style.cursor = '';
      useStore.getState().setHover(null);
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) this.pinchPrevDist = null;
    // (A pinch already nulled pointerDownPos/domeLookPointerPos, so a lifted finger
    //  can't fall through to a tap-select or a one-finger pan here.)

    if (this.joyrideLookPointerPos) {
      this.joyrideLookPointerPos = null;
      this.pointerDownPos = null;
      return;
    }

    this.domeLookPointerPos = null;
    if (!this.pointerDownPos || !this.gpuPicker) return;

    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    this.pointerDownPos = null;
    if (dx * dx + dy * dy > 25) return;

    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    this.syncPickerUniforms();
    const gpuHits = this.gpuPicker.pickArea(screenX, screenY, rect.width, rect.height);
    const store = useStore.getState();

    if (gpuHits.length === 0) {
      this.onDeselect();
      store.clearCluster();
      return;
    }

    // pickArea sorts by visual size descending; DSOs use a constant 5.0 which
    // beats any normal TLE, so gpuHits[0] is a DSO whenever one was directly
    // clicked — even if stray TLE pixels bleed into the 5×5 sample area.
    if (gpuHits[0] >= this.catalogData.length) {
      const dsoIndex = gpuHits[0] - this.catalogData.length;
      if (dsoIndex < store.dsoObjects.length) {
        store.clearCluster();
        this.onSelectDso(dsoIndex);
      }
      return;
    }

    // TLE hit path — cluster detection
    const tleHits = gpuHits.filter((i) => i < this.catalogData.length);
    const geom = this.satelliteRenderer.mesh.geometry;
    const posArr = geom.getAttribute('currentPosition') as THREE.BufferAttribute;
    const sizeArr = geom.getAttribute('size') as THREE.BufferAttribute;
    const anchorIdx = tleHits[0];
    const wx = posArr.getX(anchorIdx);
    const wy = posArr.getY(anchorIdx);
    const wz = posArr.getZ(anchorIdx);

    const clusterSet = new Set<number>(tleHits);
    const count = this.catalogData.length;
    for (let i = 0; i < count; i++) {
      if (sizeArr.getX(i) < 0.01) continue;
      const px = posArr.getX(i) - wx;
      const py = posArr.getY(i) - wy;
      const pz = posArr.getZ(i) - wz;
      if (px * px + py * py + pz * pz < CLUSTER_RADIUS_SQ) {
        clusterSet.add(i);
      }
    }

    const allIndices = Array.from(clusterSet);
    allIndices.sort((a, b) => sizeArr.getX(b) - sizeArr.getX(a));

    if (allIndices.length === 1) {
      store.clearCluster();
      this.onSelectTle(allIndices[0]);
      return;
    }

    const items = allIndices.map((i) => {
      const px = posArr.getX(i);
      const py = posArr.getY(i);
      const pz = posArr.getZ(i);
      const mag = Math.sqrt(px * px + py * py + pz * pz);
      const alt = Math.round((mag * EARTH_RADIUS_KM) - EARTH_RADIUS_KM);
      return { index: i, data: this.catalogData[i], altitude: alt };
    });
    store.setCluster(items, e.clientX, e.clientY);
  };
}
