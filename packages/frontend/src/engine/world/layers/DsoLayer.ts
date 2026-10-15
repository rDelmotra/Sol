import type * as THREE from 'three';
import { DsoRenderer } from '../../DsoRenderer';
import { DsoWorkerClient } from '../../dso/DsoWorkerClient';
import { resyncDsoCatalog } from '../../dso/dso-resync';
import { useStore } from '../../../store/useStore';
import type { DsoObject } from '../../../data/dso-types';
import { dsoIndexOf } from '../../../data/dso-index';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/**
 * Deep-space objects: owns the {@link DsoRenderer}, the {@link DsoWorkerClient}
 * (Hermite interpolation worker), the dsoObjects + ephemeris store subscriptions,
 * per-frame label projection, and the selection highlight. Non-critical: if the
 * Horizons-fed pipeline is empty/down, the rest of the scene is unaffected
 * (CLAUDE.md graceful-degradation guarantee).
 *
 * Boundary: DsoLayer owns the renderer and the worker *feed* for DSO visual
 * state. The global catalog/manifest polling that populates the store
 * (initDsoClient/stopDsoClient) is started/stopped by the Engine — that data
 * orchestration is not a visual-layer concern, so this file must not import
 * `data/dso-client`.
 *
 * Two-phase: `init(ctx)` builds the renderer synchronously (so the Engine can
 * hand it to InputManager); `activate(...)` wires the worker client + subs once
 * the catalog has bootstrapped. Cross-layer concerns (trail GL, GPU picker,
 * trail refresh) flow back to the Engine via callbacks — layers never import
 * other layers.
 */
export class DsoLayer implements Layer {
  readonly name = 'dso';
  readonly critical = false;

  private _renderer: DsoRenderer | null = null;
  private client: DsoWorkerClient | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private canvas: HTMLCanvasElement | null = null;

  private callbacks: DsoLayerCallbacks | null = null;
  private dsoUnsub: (() => void) | null = null;
  private dsoEphemerisUnsub: (() => void) | null = null;

  /**
   * The DSO renderer, or null if init hasn't run / failed. Nullable on purpose:
   * a failed non-critical DSO init must not crash consumers (InputManager) —
   * the "DSO is non-critical" guarantee.
   */
  get renderer(): DsoRenderer | null {
    return this._renderer;
  }

  init(ctx: LayerContext): void {
    this.camera = ctx.camera;
    this.canvas = ctx.renderer.domElement as HTMLCanvasElement;
    this._renderer = new DsoRenderer(ctx.scene);
  }

  /**
   * Wire the worker client + store subscriptions. Called by the Engine after the
   * TLE catalog bootstrap (the DSO pick-ID space sits above the TLE indices, so
   * the renderer needs the TLE count via `getTleCount`).
   */
  activate(callbacks: DsoLayerCallbacks): void {
    this.callbacks = callbacks;
    this.client = new DsoWorkerClient({
      onPositions: (positions, _velocities, visibleFlags) => {
        this._renderer?.updateFromWorkerBuffers(positions, visibleFlags);
      },
      onTrail: (dsoId, positions) => callbacks.onDsoTrail(dsoId, positions),
      getBootstrapState: () => {
        const { dsoObjects, dsoEphemerisById } = useStore.getState();
        return { dsoObjects, dsoEphemerisById };
      },
    });

    // Seed from the CURRENT store immediately: a remount / HMR / late DSO
    // bootstrap may have already populated dsoObjects before this layer
    // activated, in which case the change-only subscription would never fire and
    // the renderer would stay empty. The worker self-seeds ids + ephemeris from
    // the store in DsoWorkerClient.bootstrapState() (ctor → spawnWorker →
    // bootstrapState posts INIT_SNAPSHOTS with dsoEphemerisById), so only the
    // renderer geometry needs seeding here.
    const initialDsoObjects = useStore.getState().dsoObjects;
    if (initialDsoObjects.length > 0) {
      this.syncCatalog(initialDsoObjects);
    }

    // Re-init DSO geometry whenever the catalog changes; initDsoClient() fills it.
    let prevDsoObjects = useStore.getState().dsoObjects;
    this.dsoUnsub = useStore.subscribe((state) => {
      if (state.dsoObjects === prevDsoObjects) return;
      prevDsoObjects = state.dsoObjects;
      this.syncCatalog(state.dsoObjects);
    });

    let prevDsoEphemeris = useStore.getState().dsoEphemerisById;
    this.dsoEphemerisUnsub = useStore.subscribe((state) => {
      if (state.dsoEphemerisById === prevDsoEphemeris) return;
      this.client?.syncEphemerisDiff(prevDsoEphemeris, state.dsoEphemerisById);
      prevDsoEphemeris = state.dsoEphemerisById;
      if (state.showOrbitTrail && state.selectedDso) {
        this.client?.requestTrail(state.selectedDso.dsoId);
      }
    });
  }

  /** Rebuild DSO geometry + picker registration + worker ids for a catalog. */
  private syncCatalog(dsoObjects: DsoObject[], refreshTrail = true): void {
    if (!this._renderer || !this.callbacks) return;
    resyncDsoCatalog(
      {
        renderer: this._renderer,
        client: this.client,
        getTleCount: this.callbacks.getTleCount,
        onDsoGeometry: this.callbacks.onDsoGeometry,
      },
      dsoObjects,
    );
    if (refreshTrail && useStore.getState().showOrbitTrail) this.callbacks.onRefreshTrail();
  }

  update(frame: FrameContext): void {
    if (!this._renderer) return;

    this.client?.tick(frame.nowMs);
    this._renderer.updateUniforms(frame.pixelRatio);

    if (this.camera && this.canvas) {
      const labels = this._renderer.getScreenPositions(
        this.camera,
        this.canvas.clientWidth,
        this.canvas.clientHeight,
      );
      useStore.getState().setDsoLabelPositions(labels);
    }

    const selectedDso = useStore.getState().selectedDso;
    if (selectedDso !== null) {
      const idx = dsoIndexOf(useStore.getState().dsoObjects, selectedDso.dsoId);
      this._renderer.setSelectedDsoIndex(idx);
    } else {
      this._renderer.setSelectedDsoIndex(-1);
    }
  }

  // ── Engine-driven orchestration ─────────────────────────────────────────────

  /** TrackingSource bridge: DSO position + velocity for the camera/joyride. */
  getDsoKinematics(dsoIndex: number, outPos: THREE.Vector3, outVel: THREE.Vector3): boolean {
    if (!this._renderer || dsoIndex < 0 || !this._renderer.isVisible(dsoIndex)) return false;
    outPos.copy(this._renderer.getPositionAt(dsoIndex));
    if (this.client) {
      this.client.getDsoVelocity(dsoIndex, outVel);
    } else {
      outVel.set(0, 0, 0);
    }
    return true;
  }

  requestTrail(dsoId: string): void {
    this.client?.requestTrail(dsoId);
  }

  triggerImmediateTick(timestampMs: number): void {
    this.client?.triggerImmediateTick(timestampMs);
  }

  /**
   * The TLE catalog was swapped (live, a historical day, or emptied for the
   * planetarium). DSO pick IDs are encoded above the TLE count, so re-encode them
   * against the new count and re-register the pick geometry + worker ids. DSOs are
   * never hidden here: whether one is drawn depends only on its own ephemeris
   * window and the sim time (the worker's visibleFlags). The caller refreshes the
   * orbit trail, so this does not. No-op before {@link activate}.
   */
  resyncForCatalog(): void {
    this.syncCatalog(useStore.getState().dsoObjects, false);
  }

  dispose(): void {
    this.dsoUnsub?.();
    this.dsoUnsub = null;
    this.dsoEphemerisUnsub?.();
    this.dsoEphemerisUnsub = null;
    this.client?.dispose();
    this.client = null;
    this._renderer?.dispose();
    this._renderer = null;
    this.callbacks = null;
    this.camera = null;
    this.canvas = null;
  }
}

export interface DsoLayerCallbacks {
  /** Forward a built trail's positions to the trail layer (Engine gates it). */
  onDsoTrail: (dsoId: string, positions: Float32Array) => void;
  /** Register the (re)built DSO geometry with the GPU picker. */
  onDsoGeometry: (geometry: THREE.BufferGeometry, count: number) => void;
  /** Ask the Engine to refresh the orbit trail (catalog changed). */
  onRefreshTrail: () => void;
  /** TLE count — DSO pick IDs are encoded above the TLE index space. */
  getTleCount: () => number;
}
