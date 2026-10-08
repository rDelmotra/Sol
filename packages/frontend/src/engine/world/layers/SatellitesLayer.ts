import type * as THREE from 'three';
import { SatelliteRenderer } from '../../SatelliteRenderer';
import { DevValidation } from '../../DevValidation';
import { Sgp4WorkerClient, type Sgp4PositionResult } from '../../tle/Sgp4WorkerClient';
import { getSunDirection, getObserverSceneAnchor } from '../../scene/sky';
import { simClock } from '../../../time/SimClock';
import { useStore, isObserverMode, type VisibilityMode } from '../../../store/useStore';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';
import { altitudeKmFromEr } from '@orbitwatch/orbital-core';
import type { LiveBuffersShape, LiveDataPort } from '../../analytic/AnalyticRuntime';

/**
 * Satellites: THE product layer. Owns the {@link SatelliteRenderer}, the
 * {@link Sgp4WorkerClient} (~1Hz propagation), the positions→visibility→render
 * pipeline, the visible-count recompute, dev validation, and the per-frame
 * uniforms. **Critical** (the only one): a throw at init/activate/update escalates
 * via `World.onCriticalError` → `store.setLoadingError` instead of failing soft.
 *
 * Two-phase like {@link DsoLayer}: `init(ctx)` builds the renderer synchronously
 * (so the Engine can feed InputManager + build the GPU picker in the same tick);
 * `activate(...)` primes geometry + starts the worker once the catalog has
 * bootstrapped. The Engine builds the GPU picker immediately AFTER `activate()`
 * returns — safe because the worker's first POSITIONS message is async (a later
 * task), so the picker is in place before any pick. Cross-cutting concerns
 * (loading phases, selection clears, trail refresh) flow back to the Engine via
 * callbacks — layers never import other layers.
 */
export class SatellitesLayer implements Layer {
  readonly name = 'satellites';
  readonly critical = true;

  private _renderer: SatelliteRenderer | null = null;
  private client: Sgp4WorkerClient | null = null;
  private catalog: EnrichedTLEObject[] = [];
  private devValidation: DevValidation | null = null;
  private firstPositionReceived = false;
  private callbacks: SatellitesLayerCallbacks | null = null;
  private filterUnsub: (() => void) | null = null;
  /** True while satellites are hidden for a planetarium (uncovered-past) scrub. */
  private hidden = false;
  /** Latest raw worker buffers (TEME ER) — the analytic live source's fast path. */
  private latestBuffers: LiveBuffersShape | null = null;

  /**
   * The satellite renderer, or null if init hasn't run / failed. Nullable on
   * purpose: a critical init failure is escalated (error screen), not crashed —
   * the Engine guards its consumers (InputManager, GPU picker) on this.
   */
  get renderer(): SatelliteRenderer | null {
    return this._renderer;
  }

  /** True once the first SGP4 propagation has arrived (camera moves gate on this). */
  isReady(): boolean {
    return this.firstPositionReceived;
  }

  init(ctx: LayerContext): void {
    this._renderer = new SatelliteRenderer(ctx.scene);
    if (import.meta.env.DEV) {
      this.devValidation = new DevValidation(ctx.renderer);
    }
  }

  /**
   * Prime renderer geometry + start SGP4 propagation + own the satellite-visibility
   * subscription. Called by the Engine after the TLE catalog bootstrap.
   */
  activate(
    catalog: EnrichedTLEObject[],
    tles: ConstructorParameters<typeof Sgp4WorkerClient>[0],
    callbacks: SatellitesLayerCallbacks,
  ): void {
    if (!this._renderer) {
      // Critical layer: activation before a successful init is a programming error,
      // not a soft path. Throw so World.runLayerCommand escalates it (loud, not a
      // silent no-op that would leave loading stuck at 'initializing').
      throw new Error('SatellitesLayer.activate() called before init()');
    }
    const renderer = this._renderer;
    this.catalog = catalog;
    this.callbacks = callbacks;

    renderer.initFromCatalog(catalog);
    renderer.recolorBy(catalog, useStore.getState().colorBy);
    this.devValidation?.initFromCatalog(catalog);

    // Prominence boost for the ISS — size only; its color follows the active
    // color-by dimension like every other object (no special-case tint).
    const issIndex = catalog.findIndex((d) => d.noradId === 25544);
    if (issIndex !== -1) {
      renderer.setSatelliteSize(issIndex, 2.0);
    }

    // Satellite visibility reacts to the facet filters (type/status/sector/purpose/
    // country/regime), visibility mode, and observer location; the point-cloud COLOR
    // reacts to `colorBy`. The subscription lives HERE so "what changes satellites" is
    // in one place. Cross-cutting effects (observer marker, observer-sky camera, orbit
    // trail) flow back to the Engine via callbacks. Fires on Zustand's notify turn
    // (outside World) → wrapped in guard() so a throw escalates to the critical path.
    const s0 = useStore.getState();
    let prevType = s0.typeFilters;
    let prevStatus = s0.statusFilters;
    let prevSector = s0.sectorFilters;
    let prevPurpose = s0.purposeFilters;
    let prevCountry = s0.countryFilter;
    let prevProgram = s0.programFilter;
    let prevLaunch = s0.launchFilter;
    let prevOwner = s0.ownerFilter;
    let prevAnalytic = s0.analyticFilter;
    let prevReg = s0.regimeFilters;
    let prevColorBy = s0.colorBy;
    let prevMode = s0.visibilityMode;
    let prevObs = s0.observerLocation;
    this.filterUnsub = useStore.subscribe((state) => {
      const filtersChanged =
        state.typeFilters !== prevType ||
        state.statusFilters !== prevStatus ||
        state.sectorFilters !== prevSector ||
        state.purposeFilters !== prevPurpose ||
        state.countryFilter !== prevCountry ||
        state.programFilter !== prevProgram ||
        state.launchFilter !== prevLaunch ||
        state.ownerFilter !== prevOwner ||
        state.analyticFilter !== prevAnalytic ||
        state.regimeFilters !== prevReg;
      const colorByChanged = state.colorBy !== prevColorBy;
      const obsLocChanged = state.observerLocation !== prevObs;
      const modeChanged = state.visibilityMode !== prevMode;
      if (!filtersChanged && !colorByChanged && !obsLocChanged && !modeChanged) {
        return;
      }
      const fromMode = prevMode;
      prevType = state.typeFilters;
      prevStatus = state.statusFilters;
      prevSector = state.sectorFilters;
      prevPurpose = state.purposeFilters;
      prevCountry = state.countryFilter;
      prevProgram = state.programFilter;
      prevLaunch = state.launchFilter;
      prevOwner = state.ownerFilter;
      prevAnalytic = state.analyticFilter;
      prevReg = state.regimeFilters;
      prevColorBy = state.colorBy;
      prevMode = state.visibilityMode;
      prevObs = state.observerLocation;

      this.guard('filter', () => {
        // Color-by changes only repaint the color buffer — no visibility recompute.
        if (colorByChanged && this._renderer) {
          this._renderer.recolorBy(this.catalog, state.colorBy);
        }
        // Filter / mode / observer changes recompute the visible set + counts.
        if (filtersChanged || modeChanged || obsLocChanged) {
          this.recomputeVisibleCounts(state);
        }

        if (obsLocChanged) {
          callbacks.onObserverChange(state.observerLocation);
        }

        if (
          isObserverMode(state.visibilityMode) &&
          state.observerLocation &&
          (modeChanged || obsLocChanged)
        ) {
          // Covers entering visual/dome AND switching between them (re-enter
          // re-seeds the rig + FOV for the new mode).
          callbacks.onEnterObserverSky(state.observerLocation, state.visibilityMode);
        } else if (modeChanged && isObserverMode(fromMode) && !isObserverMode(state.visibilityMode)) {
          callbacks.onExitObserverSky();
        }

        if (state.showOrbitTrail && (modeChanged || obsLocChanged)) {
          callbacks.onTrailRefresh();
        }
      });
    });

    this.client = new Sgp4WorkerClient(tles, {
      onReady: (objectCount) => this.guard('onReady', () => callbacks.onReady(objectCount)),
      onPositions: (result) => this.onPositions(result),
    });
  }

  /**
   * The live-data port the Engine's AnalyticRuntime reads through. Not
   * `isReady()` on the layer itself — that one means "first position arrived".
   * Here ready = activated AND first worker buffers retained (the exact gate
   * the old `runAnalyticProgram` used).
   */
  getLiveDataPort(): LiveDataPort {
    return {
      isReady: () => !!this.callbacks && !!this.latestBuffers,
      getCatalog: () => this.catalog,
      getLatestBuffers: () => this.latestBuffers,
      getVisualNoradIds: () => this.callbacks?.getVisualNoradIds() ?? new Set<number>(),
    };
  }

  /**
   * Run a fn that executes in a layer-owned async callback (worker `onmessage` /
   * store subscription) — paths World can't wrap. A throw is escalated through the
   * critical-error route (`callbacks.onError` → `world.reportLayerFailure`) so the
   * worker is torn down + a user-visible error shown, instead of vanishing.
   */
  private guard(phase: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.callbacks?.onError(err, phase);
    }
  }

  private onPositions(result: Sgp4PositionResult): void {
    // Runs in the worker's onmessage turn (outside World) — guard escalates any
    // throw in the heavy path to the critical-error route. (P1)
    this.guard('onPositions', () => {
      // Planetarium: while hidden (uncovered past) skip all render/count work so no
      // stale counts leak. Only entered post-boot (boot is always live), so the
      // firstPosition handshake below is never starved.
      if (this.hidden) return;
      const renderer = this._renderer;
      const callbacks = this.callbacks;
      if (!renderer || !callbacks) return;

      // Retain the raw TEME buffers for the analytic live source. Safe: the worker
      // transfers ownership to this thread; the renderer copies into attributes.
      this.latestBuffers = {
        positions: result.positions,
        velocities: result.velocities,
        validFlags: result.validFlags,
        timestamp: result.timestamp,
      };

      // P2 resident-set tick: fires AFTER latestBuffers is fresh so a resident
      // program re-executed from this callback sees this tick's data. The
      // Engine's AnalyticRuntime owns the ResidentSet (cross-cutting orchestration, not a layer
      // concern) — this is just the callback firing, same pattern as every
      // other cross-cutting effect below. Runs inside this fn's guard(), so a
      // throw from the Engine's onTick still escalates through the normal
      // critical-error route rather than propagating raw — though ResidentSet
      // itself is contractually never allowed to throw out of tick().
      callbacks.onTick?.();

      const state = useStore.getState();
      const propagationDate = new Date(result.timestamp);
      const observerAnchor = this.getObserverSceneAnchorForState(state, propagationDate);
      const sunDir = getSunDirection(propagationDate);
      const visualNoradIds = callbacks.getVisualNoradIds();

      const counts = result.isSnap
        ? renderer.snapPositions(
            result.positions,
            result.validFlags,
            result.objectCount,
            observerAnchor,
            sunDir,
            state.visibilityMode,
            this.catalog,
            state,
            visualNoradIds,
          )
        : renderer.updatePositions(
            result.positions,
            result.validFlags,
            result.objectCount,
            observerAnchor,
            sunDir,
            state.visibilityMode,
            this.catalog,
            state,
            visualNoradIds,
          );

      const store = useStore.getState();
      store.setVisibleCounts(counts.categoryCounts, counts.regimeCounts);
      store.setVisibleFacetCounts(counts.facetCounts);

      renderer.material.uniforms.uT.value = 0.0;

      const post = useStore.getState();
      if (post.showOrbitTrail && post.selectedIndex !== null) {
        callbacks.onTrailRefresh();
      }

      this.devValidation?.runChecks(result.positions, result.validFlags, result.objectCount);

      if (!this.firstPositionReceived) {
        this.firstPositionReceived = true;
        callbacks.onFirstPosition();
      }
    });
  }

  /** Recompute visible facet/regime counts (filter or visual-list change), no new propagation. */
  recomputeVisibleCounts(state: ReturnType<typeof useStore.getState>): void {
    if (
      !this._renderer ||
      !this.callbacks ||
      !this.firstPositionReceived ||
      this.catalog.length === 0 ||
      this.hidden
    ) {
      return;
    }

    const simDate = simClock.date();
    const observerAnchor = this.getObserverSceneAnchorForState(state, simDate);
    const sunDir = getSunDirection(simDate);

    const counts = this._renderer.applyFilters(
      this.catalog,
      state,
      observerAnchor,
      sunDir,
      state.visibilityMode,
      this.callbacks.getVisualNoradIds(),
    );
    const store = useStore.getState();
    store.setVisibleCounts(counts.categoryCounts, counts.regimeCounts);
    store.setVisibleFacetCounts(counts.facetCounts);

    const sel = state.selectedIndex;
    if (sel !== null && sel < this.catalog.length) {
      const sizeArr = this._renderer.mesh.geometry.getAttribute('size').array as Float32Array;
      if (sizeArr[sel] < 0.01) {
        this.callbacks.onSelectionInvalidated();
      }
    }
  }

  private getObserverSceneAnchorForState(
    state: ReturnType<typeof useStore.getState>,
    date: Date,
  ): { position: THREE.Vector3; up: THREE.Vector3 } | null {
    if (state.visibilityMode === 'all' || !state.observerLocation) {
      return null;
    }
    return getObserverSceneAnchor(
      state.observerLocation.lat,
      state.observerLocation.lon,
      state.observerLocation.alt,
      date,
    );
  }

  update(frame: FrameContext): void {
    if (!this._renderer || this.hidden) return;

    this._renderer.material.uniforms.uT.value = frame.uT;

    const selectedIdx = useStore.getState().selectedIndex;
    this._renderer.updateSelectedUniforms(
      selectedIdx !== null ? selectedIdx : -1,
      frame.selectionTimeSinceArrival,
    );

    this._renderer.updateUniforms(frame.cameraDistance, frame.pixelRatio);

    this.devValidation?.tickFrame();
  }

  // ── TrackingSource bridge ────────────────────────────────────────────────────

  /** GPU-side interpolation factor (uT), fresh from the worker client's timing. */
  getInterpolationFactor(): number {
    return this.client?.getTickState().uT ?? 0.0;
  }

  /** Fill outPos/outVel with the interpolated TLE state at uT. False if index invalid. */
  getTleKinematics(
    index: number,
    uT: number,
    outPos: THREE.Vector3,
    outVel: THREE.Vector3,
  ): boolean {
    if (!this._renderer || index < 0 || index >= this.catalog.length) return false;
    outPos.copy(this._renderer.getInterpolatedPosition(index, uT));
    // Never leave outVel stale: zero it when the worker client isn't up yet.
    if (this.client) {
      this.client.getInterpolatedVelocity(index, uT, outVel);
    } else {
      outVel.set(0, 0, 0);
    }
    return true;
  }

  /** Current altitude (km) of a TLE object, from its snapped position. */
  getTleAltitudeKm(index: number): number {
    if (!this._renderer) return 0;
    const posArr = this._renderer.mesh.geometry.getAttribute('currentPosition');
    const x = posArr.getX(index);
    const y = posArr.getY(index);
    const z = posArr.getZ(index);
    return altitudeKmFromEr({ x, y, z });
  }

  // ── Engine-driven commands ───────────────────────────────────────────────────

  /** Sim-time jump: immediate snap + reset interpolation tween. */
  requestImmediateSnap(): void {
    this.client?.requestImmediateSnap();
    if (this._renderer) this._renderer.material.uniforms.uT.value = 0.0;
  }

  /**
   * Re-seed the layer from a NEW catalog (historical time-scrub): rebuild the
   * renderer's colors/pickIds in place — `reinitFromCatalog` clears any ghost tail
   * a smaller catalog would leave — re-apply the ISS tint, and re-INIT the SGP4
   * worker. Visible counts + positions refresh when the post-reseed SNAP arrives
   * via `onPositions` (which reads the now-updated `this.catalog`). No-op before
   * `activate()`. The Engine owns the surrounding orchestration (selection
   * re-resolve, picker resize, store sync).
   */
  reseedCatalog(
    catalog: EnrichedTLEObject[],
    tles: ConstructorParameters<typeof Sgp4WorkerClient>[0],
  ): void {
    if (!this._renderer || !this.client) return;
    this.catalog = catalog;
    this._renderer.reinitFromCatalog(catalog);
    this._renderer.recolorBy(catalog, useStore.getState().colorBy);
    // Refresh dev-validation indices (ISS / GEO) for the new catalog — stale indices
    // would validate the wrong objects after a re-seed.
    this.devValidation?.initFromCatalog(catalog);

    // ISS prominence boost (size only; color follows the active color-by).
    const issIndex = catalog.findIndex((d) => d.noradId === 25544);
    if (issIndex !== -1) {
      this._renderer.setSatelliteSize(issIndex, 2.0);
    }

    this.client.reseed(tles);
  }

  /**
   * Planetarium hide/show for an uncovered-past scrub: the point cloud goes
   * invisible and the per-frame + worker-driven paths early-out
   * (`onPositions`/`update`/`recomputeVisibleCounts`), so no stale counts leak
   * while hidden. The Engine owns the surrounding orchestration (picker size 0,
   * zeroed store counts, cleared selection) and re-seeds on restore. Mirrors
   * {@link DsoLayer.setHidden}.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (this._renderer) this._renderer.mesh.visible = !hidden;
  }

  /** Best-estimate propagation timestamp for the orbit-trail anchor. */
  getPropagationTimestampMs(): number {
    return this.client?.getCurrentPropagationTimestampMs() ?? simClock.now();
  }

  dispose(): void {
    this.latestBuffers = null;
    this.filterUnsub?.();
    this.filterUnsub = null;
    this.client?.dispose();
    this.client = null;
    this._renderer?.dispose();
    this._renderer = null;
    // DevValidation owns no GL resources (Engine never disposed it) — just drop it.
    this.devValidation = null;
    this.catalog = [];
    this.callbacks = null;
    this.firstPositionReceived = false;
  }
}

type ObserverLoc = { lat: number; lon: number; alt: number };

export interface SatellitesLayerCallbacks {
  /** Curated visual NORAD set (owned by the Engine's VisualListPoller). */
  getVisualNoradIds: () => Set<number>;
  /**
   * A throw surfaced in a layer-owned async callback (worker / store sub) → route
   * to `world.reportLayerFailure` for critical escalation. (P1)
   */
  onError: (err: unknown, phase: string) => void;
  /** SGP4 worker reported READY → loading phase 'propagating'. */
  onReady: (objectCount: number) => void;
  /** First propagation batch arrived → input enable + loading phase 'ready'. */
  onFirstPosition: () => void;
  /** Selected satellite was filtered out (size 0) → clear the TLE selection. */
  onSelectionInvalidated: () => void;
  /** New positions / filter change while a trail is active → regenerate it. */
  onTrailRefresh: () => void;
  /** Observer location changed → reposition the observer marker. */
  onObserverChange: (loc: ObserverLoc | null) => void;
  /** Entered visual/dome (or moved, or switched between them) with an observer set
   *  → enter the observer-sky rig for that mode. */
  onEnterObserverSky: (loc: ObserverLoc, mode: VisibilityMode) => void;
  /** Left visual/dome for a non-observer mode → return the camera home. */
  onExitObserverSky: () => void;
  /**
   * Fires once per SGP4 worker tick (~1 Hz), right after `latestBuffers` is
   * refreshed. (P2) The Engine's clock for the resident set — its
   * `AnalyticRuntime` drives the `ResidentSet` tick from here. Optional so call sites that don't
   * need residency (tests, a future non-Engine host) can omit it.
   */
  onTick?: () => void;
}
