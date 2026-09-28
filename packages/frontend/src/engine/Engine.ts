import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getSunDirection } from './scene/sky';
import { FUTURE_HORIZON_DAYS, MS_PER_DAY, gmst } from '@orbitwatch/orbital-core';
import type { VisualListResolvedResult } from '../data/visualList';
import { VisualListPoller, buildCatalogResult, type TleCatalogResult } from '../data/tle-client';
import { bootstrapCatalog } from '../data/bootstrapCatalog';
import { fetchHistoryCoverage, fetchHistoryDay, utcDay } from '../data/history-client';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore } from '../store/useStore';
import { GPUPicker } from './GPUPicker';
import { initDsoClient, stopDsoClient } from '../data/dso-client';
import { simClock } from './SimClock';
import { InputManager } from './input/InputManager';
import { Renderer } from './render/Renderer';
import { Camera } from './render/Camera';
import { NavigationController } from './controllers/NavigationController';
import type { TrackingSource } from './controllers/TrackingSource';
import { World } from './world/World';
import { StarfieldLayer } from './world/layers/StarfieldLayer';
import { EarthLayer } from './world/layers/EarthLayer';
import { TrailsLayer } from './world/layers/TrailsLayer';
import { DsoLayer } from './world/layers/DsoLayer';
import { SatellitesLayer } from './world/layers/SatellitesLayer';
import { ObserverMarkerLayer } from './world/layers/ObserverMarkerLayer';
import { HorizonLayer } from './world/layers/HorizonLayer';
import { DomeSkyLayer } from './world/layers/DomeSkyLayer';
import { registerEngineCommands, type EngineCommands } from './command/EngineCommands';
import type { FrameContext } from './render/Layer';
import { ResidentSet } from './resident/ResidentSet';
import { validateProgram } from '@orbitwatch/analytic';

/** What the satellite render plane currently shows for the view-time. */
type CatalogTarget =
  | { kind: 'live' }
  | { kind: 'day'; day: string }
  | { kind: 'hidden' };

/** Symmetric ease for the return-to-present glide (no overshoot — never passes "now"). */
function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

export class Engine {
  private static readonly EMPTY_NORAD_SET: Set<number> = new Set();
  /** Debounce window before a settled scrub triggers a catalog re-seed. */
  private static readonly RESEED_DEBOUNCE_MS = 200;
  /** "Return to present" glide duration. */
  private static readonly GLIDE_DURATION_MS = 1200;
  /** Min gap between scrub/glide-driven satellite snaps (~11 Hz). */
  private static readonly SCRUB_SNAP_MIN_MS = 90;

  private renderer: Renderer;
  private scene: THREE.Scene;
  private cameraRig: Camera;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private clock: THREE.Clock;
  private earthLayer: EarthLayer;
  private world: World;
  private animationId: number | null = null;
  private satellitesLayer: SatellitesLayer;
  private observerMarkerLayer: ObserverMarkerLayer;
  private horizonLayer: HorizonLayer;
  private dsoLayer: DsoLayer;
  private gpuPicker: GPUPicker | null = null;
  private catalogData: EnrichedTLEObject[] = [];
  private inputManager: InputManager | null = null;
  private trailsLayer: TrailsLayer;
  private nav: NavigationController;
  /** P2: standing analytic programs re-evaluated every SGP4 worker tick (~1 Hz)
   *  via SatellitesLayer's onTick callback. Cross-cutting orchestration (not a
   *  layer concern) — owned here, driven by `satellitesLayer.runAnalyticProgram`. */
  private residentSet: ResidentSet = new ResidentSet();
  private trailUnsub: (() => void) | null = null;
  private visualListPoller: VisualListPoller | null = null;
  private lastSimTimeUpdateAt = 0;
  private isDisposed = false;
  private criticalFailed = false;
  private resizeObserver: ResizeObserver | null = null;
  // ── Historical time-scrub (A6) + planetarium / glide (Pass 2) ───────────────
  /** Cached live (bootstrap) catalog result for instant return to "now". */
  private liveResult: TleCatalogResult | null = null;
  /** Which catalog the render plane currently shows. */
  private loadedTarget: CatalogTarget = { kind: 'live' };
  private isReseeding = false;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  /** Active "return to present" glide (Pass 2), advanced by the rAF loop. */
  private glide: { fromMs: number; startedAt: number; durationMs: number } | null = null;
  /** Throttle clock for scrub/glide-driven satellite snaps. */
  private lastScrubSnapAt = 0;
  /** Last wheel scrub-preview time — defers the reseed mid-drag (reseed on settle). */
  private lastScrubAt = 0;
  /** noradId of the selection stashed entering the planetarium, restored on return. */
  private pendingSelectionNorad: number | null = null;
  /** Throttle clock for glide-driven UI mirror pushes (decoupled from the 4 Hz block). */
  private lastGlideUiAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    // ── Renderer ──────────────────────────────────────────────────────────────
    this.renderer = new Renderer(canvas);

    // ── Scene ─────────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();

    // ── Camera + controls ─────────────────────────────────────────────────────
    this.cameraRig = new Camera(canvas);
    this.camera = this.cameraRig.instance;
    this.controls = this.cameraRig.controls;

    // ── Lights ────────────────────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0x101820, 0.15);
    this.scene.add(ambient);

    // ── World (layer registry) ──────────────────────────────────────────────────
    // Migrating subsystems into layers one at a time (Slice 5).
    const maxAnisotropy = this.renderer.getMaxAnisotropy();
    this.earthLayer = new EarthLayer();
    this.observerMarkerLayer = new ObserverMarkerLayer();
    this.horizonLayer = new HorizonLayer();
    this.trailsLayer = new TrailsLayer();
    this.dsoLayer = new DsoLayer();
    this.satellitesLayer = new SatellitesLayer();
    this.world = new World({
      onCriticalError: (err) => this.handleCriticalError(err),
    });
    this.world.register(this.earthLayer);
    // Dome-only gradient sky backdrop (drawn first via renderOrder; replaces the
    // from-space Earth/atmosphere when standing on the surface in dome mode).
    this.world.register(new DomeSkyLayer());
    this.world.register(this.observerMarkerLayer);
    // Parents to the Earth group (like the observer marker), so its scene-root
    // registration order is irrelevant; dome-only visibility toggled in update().
    this.world.register(this.horizonLayer);
    this.world.register(new StarfieldLayer());
    this.world.register(this.trailsLayer);
    this.world.register(this.dsoLayer);
    // Satellites registered last so the point cloud is added to the scene last
    // (drawn over Earth/DSO), matching the prior inline order. (ObserverMarker
    // parents to the Earth group, not the scene root, so its order is irrelevant.)
    this.world.register(this.satellitesLayer);
    // Synchronous layers (all current ones) fully init in this call, so their
    // renderers are ready for InputManager / TrackingSource below.
    this.world.init({
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer.instance,
      maxAnisotropy,
    });
    // The observer marker rotates with the Earth — parent it to the (now-built)
    // Earth group. Cross-layer wiring done by the Engine (layers never import layers).
    this.observerMarkerLayer.setParent(this.earthLayer.group);
    this.horizonLayer.setParent(this.earthLayer.group);

    // ── Navigation (camera state machine) ──────────────────────────────────────
    this.nav = new NavigationController(
      this.camera,
      this.controls,
      this.createTrackingSource(),
      { onCancelJoyrideLook: () => this.inputManager?.cancelJoyrideLook() },
    );

    // ── Clock ─────────────────────────────────────────────────────────────────
    this.clock = new THREE.Clock();

    // ── Resize handler ────────────────────────────────────────────────────────
    // ResizeObserver fires for any cause: window resize, tab/panel reflow,
    // browser zoom, or moving to a different-DPI monitor — more reliable than
    // the window 'resize' event which misses layout-driven size changes.
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(canvas);

    // ── Input manager ─────────────────────────────────────────────────────────
    // Guarded: a critical satellites-init failure leaves no renderer (and has
    // already escalated to the error screen), so skip input wiring entirely.
    const satelliteRenderer = this.satellitesLayer.renderer;
    if (satelliteRenderer) {
      this.inputManager = new InputManager(
        {
          canvas,
          satelliteRenderer,
          dsoRenderer: this.dsoLayer.renderer,
          controls: this.controls,
        },
        {
          onSelectTle: (index) => this.nav.selectByIndex(index),
          onSelectDso: (dsoIndex) => this.nav.selectDsoByIndex(dsoIndex),
          onDeselect: () => {
            useStore.getState().setSelectedSatellite(null, null);
            useStore.getState().setSelectedDso(null);
          },
          onDragExitFollow: () => this.nav.notifyDragExitedFollowing(),
          onJoyrideLookInput: (dx, dy) => this.nav.addJoyrideLookInput(dx, dy),
          onDomeLookInput: (dAz, dEl) => this.nav.addDomeLookInput(dAz, dEl),
          onDomeZoom: (factor) => this.nav.addDomeZoom(factor),
        },
      );
    }

    // ── Load TLE data and start propagation ───────────────────────────────────
    this.initWorker();
  }

  private async initWorker(): Promise<void> {
    const store = useStore.getState();
    try {
      store.setLoadingPhase('fetching');
      const apiUrl = import.meta.env.VITE_API_URL ?? '';

      // Visual list poller — non-blocking, starts in background
      store.setVisualListState({
        status: 'loading',
        version: null,
        source: null,
        stale: false,
        count: 0,
        updatedAt: null,
        message: null,
      });
      this.visualListPoller = new VisualListPoller(apiUrl, (result) => {
        this.applyVisualListResult(result);
      });
      this.visualListPoller.start();

      // One-time catalog bootstrap — pure data (fetch + store seed). Renderer
      // priming + GPU picker stay here on the render side (data/ never imports engine/).
      const { catalogData, tles } = await bootstrapCatalog(apiUrl);

      if (this.isDisposed) return;

      this.catalogData = catalogData;
      this.inputManager?.setCatalogData(catalogData);

      // Cache the live catalog (counts + tles) so returning to "now" is instant,
      // and probe history coverage (non-blocking) to bound the scrubber later.
      this.liveResult = buildCatalogResult(catalogData);
      void fetchHistoryCoverage(apiUrl).then((cov) => {
        if (!this.isDisposed) useStore.getState().setHistoryCoverage(cov);
      });

      registerEngineCommands(this.buildEngineCommands());

      // ── Dev-only resident-set console (P2) ────────────────────────────────────
      // window.__resident.add(program) — validate → ResidentSet.add() → typed
      // {ok:true,hash} or a typed rejection (universe:'all' / timeScan cap /
      // total cap). Mirrors SatellitesLayer's window.__analytic hook, but lives
      // here because the Engine (not the layer) owns the ResidentSet. Doesn't
      // need the satellites layer to be activated yet — add()/remove()/list()/
      // getRecentDeltas() are pure bookkeeping; only tick() (driven by the
      // worker) actually executes anything. Removed in dispose().
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__resident = {
          add: (program: unknown) => {
            const v = validateProgram(program, { nowMs: simClock.now() });
            if (!v.ok) return { issues: v.issues };
            return this.residentSet.add(v.program);
          },
          remove: (hash: string) => this.residentSet.remove(hash),
          list: () => this.residentSet.list(),
          deltas: (n?: number) => this.residentSet.getRecentDeltas(n),
        };
        console.info(
          '[resident] window.__resident.{add,remove,list,deltas} ready — add(program) validates first',
        );
      }

      // ── Satellites layer activation (renderer prime + SGP4 worker) ───────────
      // Critical layer: if activate throws, World escalates it (onCriticalError →
      // setLoadingError) — same user-visible outcome as the old try/catch around
      // worker construction. The GPU picker is built right after activate returns;
      // safe because the worker's first POSITIONS message is async (a later task).
      console.log(`Loaded ${tles.length} TLEs from backend`);
      useStore.getState().setLoadingPhase('initializing');

      const satellitesActivated = this.world.runLayerCommand(
        this.satellitesLayer,
        'activate',
        () =>
          this.satellitesLayer.activate(catalogData, tles, {
            getVisualNoradIds: () => this.getVisualNoradIds(),
            onError: (err, phase) =>
              this.world.reportLayerFailure(this.satellitesLayer, err, phase),
            onReady: () => {
              // Only the INITIAL boot drives the loading phase. A re-seed (history
              // scrub / return-to-present) re-emits READY too, but must NOT flip back
              // to 'propagating' — that unmounts every ready-gated overlay (HUD,
              // TimeScrubber, …) and never recovers (the first-position latch fires
              // once). Re-seeds are seamless; the snap repaints in place.
              if (useStore.getState().loadingPhase !== 'ready') {
                useStore.getState().setLoadingPhase('propagating');
              }
            },
            onFirstPosition: () => {
              this.inputManager?.setFirstPositionReceived(true);
              useStore.getState().setLoadingPhase('ready');
            },
            onSelectionInvalidated: () =>
              useStore.getState().setSelectedSatellite(null, null),
            onTrailRefresh: () => this.refreshOrbitTrail(),
            onObserverChange: (loc) => {
              this.world.runLayerCommand(this.observerMarkerLayer, 'setLocation', () =>
                this.observerMarkerLayer.setLocation(loc),
              );
              this.world.runLayerCommand(this.horizonLayer, 'setLocation', () =>
                this.horizonLayer.setLocation(loc),
              );
            },
            onEnterObserverSky: (loc, mode) => this.nav.enterObserverSky(loc, mode),
            onExitObserverSky: () => this.nav.exitObserverSky(),
            onTick: () => this.tickResidentSet(),
          }),
      );

      if (!satellitesActivated) {
        // The product-critical layer is dead. World.onCriticalError →
        // handleCriticalError() has already shown the error + torn down the
        // loop/picker/input; don't keep wiring DSO/trail onto a dead engine.
        return;
      }

      const satelliteRenderer = this.satellitesLayer.renderer;
      if (satelliteRenderer) {
        this.gpuPicker = new GPUPicker(
          this.renderer.instance,
          this.camera,
          satelliteRenderer,
          catalogData.length,
        );
        this.inputManager?.setGpuPicker(this.gpuPicker);
      }

      // ── DSO layer activation (worker client + subscriptions) ─────────────────
      // Guarded: if DSO init failed (non-critical) this is skipped; if activation
      // throws, World isolates it so DSO fails soft instead of failing the TLE init.
      const dsoActivated = this.world.runLayerCommand(this.dsoLayer, 'activate', () =>
        this.dsoLayer.activate({
          onDsoTrail: (dsoId, positions) => {
            // Gate: only apply if trail is active and this DSO is selected
            const state = useStore.getState();
            if (!state.showOrbitTrail || state.selectedDso?.dsoId !== dsoId) return;
            this.world.runLayerCommand(this.trailsLayer, 'generateFromPositions', () =>
              this.trailsLayer.generateFromPositions(positions),
            );
          },
          onDsoGeometry: (geometry, count) => this.gpuPicker?.addDsoGeometry(geometry, count),
          onRefreshTrail: () => this.refreshOrbitTrail(),
          getTleCount: () => this.catalogData.length,
        }),
      );

      // Global DSO catalog/manifest polling (populates the store the DSO layer
      // reacts to) — data orchestration lives here, not in the visual layer.
      // Only start it if the DSO layer actually activated: no point feeding a
      // disabled visual layer (keeps the "DSO fails soft" story honest).
      if (dsoActivated) {
        initDsoClient().catch((err) => console.warn('DSO client init error:', err));
      }

      // (Satellite-visibility subscription — category/regime/mode/observer — now
      // lives in SatellitesLayer.activate(); cross-cutting effects route back here
      // via its callbacks above.)

      // ── Orbit trail subscription ─────────────────────────────────────────────
      let prevShowTrail = useStore.getState().showOrbitTrail;
      let prevSelectedIndex = useStore.getState().selectedIndex;
      let prevSelectedDsoId = useStore.getState().selectedDso?.dsoId ?? null;
      this.trailUnsub = useStore.subscribe((state) => {
        const selectedDsoId = state.selectedDso?.dsoId ?? null;
        const changed =
          state.showOrbitTrail !== prevShowTrail ||
          state.selectedIndex !== prevSelectedIndex ||
          selectedDsoId !== prevSelectedDsoId;

        if (!changed) {
          return;
        }

        prevShowTrail = state.showOrbitTrail;
        prevSelectedIndex = state.selectedIndex;
        prevSelectedDsoId = selectedDsoId;

        this.refreshOrbitTrail(state);
      });
    } catch (err) {
      console.error('Failed to initialize SGP4 worker:', err);
      useStore.getState().setLoadingError(
        err instanceof Error ? err.message : 'Failed to load satellite data',
      );
    }
  }

  /**
   * Build the {@link TrackingSource} adapter the NavigationController reads through.
   * This is the only place that bridges the camera to the layers, keeping the
   * controller itself free of those imports. Uses live field reads + optional
   * chaining so it's valid before the catalog/worker exist (set in initWorker).
   */
  private createTrackingSource(): TrackingSource {
    return {
      isReady: () => this.satellitesLayer.isReady(),
      getTleCount: () => this.catalogData.length,
      getTleObject: (index) => this.catalogData[index],
      getTleAltitudeKm: (index) => this.satellitesLayer.getTleAltitudeKm(index),
      getInterpolationFactor: () => this.satellitesLayer.getInterpolationFactor(),
      getTleKinematics: (index, uT, outPos, outVel) =>
        this.satellitesLayer.getTleKinematics(index, uT, outPos, outVel),
      getDsoKinematics: (dsoIndex, outPos, outVel) =>
        this.dsoLayer.getDsoKinematics(dsoIndex, outPos, outVel),
    };
  }

  /**
   * The imperative command surface the UI (+ future voicebot) triggers on the
   * engine — bound to the NavigationController + sim-time hook, registered once.
   */
  private buildEngineCommands(): EngineCommands {
    return {
      selectByIndex: (index) => this.nav.selectByIndex(index),
      flyTo: (index) => this.nav.flyToSatellite(index),
      joyride: (index) => this.nav.joyrideSatellite(index),
      resetCamera: () => this.nav.resetCamera(),
      flyToDso: (dsoId) => this.nav.flyToDso(dsoId),
      joyrideDso: (dsoId) => this.nav.joyrideDso(dsoId),
      simTimeJump: () => this.onSimTimeJump(),
      scrubPreview: () => this.onScrubPreview(),
      returnToPresent: () => this.startGlideToLive(),
      runAnalytic: (program) => {
        const out = this.satellitesLayer.runAnalyticProgram(program);
        return 'notReady' in out ? null : out;
      },
    };
  }

  /**
   * P2 resident-set clock: called from SatellitesLayer's onTick, itself fired
   * once per SGP4 worker tick (~1 Hz) right after fresh buffers land. Re-runs
   * every standing program via `runAnalyticProgram` (side-effect-free — reads
   * the same buffers the renderer just consumed) and reports the entered/
   * exited deltas. `ResidentSet.tick()` contractually never throws — a bad
   * resident is contained inside it — but this call still runs inside
   * SatellitesLayer's `guard('onPositions', …)`, the same critical-escalation
   * path everything else in that callback uses, so nothing here can bypass it.
   */
  private tickResidentSet(): void {
    const deltas = this.residentSet.tick(
      (program) => this.satellitesLayer.runAnalyticProgram(program),
      simClock.now(),
    );
    if (import.meta.env.DEV) {
      for (const d of deltas) {
        console.info(
          `[resident ${d.programHash}] +${d.entered.length} entered, -${d.exited.length} exited`,
          d,
        );
      }
    }
  }

  private getVisualNoradIds(): Set<number> {
    return this.visualListPoller?.visualNoradIds ?? Engine.EMPTY_NORAD_SET;
  }

  private applyVisualListResult(result: VisualListResolvedResult): void {
    const store = useStore.getState();

    store.setVisualListState({
      status: result.status,
      version: result.version,
      source: result.source,
      stale: result.stale,
      count: result.ids.size,
      updatedAt: Date.now(),
      message: result.message,
    });

    // Dome highlights react to the curated list updating → recompute counts.
    this.world.runLayerCommand(this.satellitesLayer, 'recompute', () =>
      this.satellitesLayer.recomputeVisibleCounts(useStore.getState()),
    );
  }

  private refreshOrbitTrail(
    state: ReturnType<typeof useStore.getState> = useStore.getState(),
  ): void {
    if (!state.showOrbitTrail) {
      this.world.runLayerCommand(this.trailsLayer, 'clear', () => this.trailsLayer.clear());
      return;
    }

    const selectedIndex = state.selectedIndex;
    if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < this.catalogData.length) {
      const sat = this.catalogData[selectedIndex];
      const anchorMs = this.satellitesLayer.getPropagationTimestampMs();
      this.world.runLayerCommand(this.trailsLayer, 'generate', () =>
        this.trailsLayer.generate(sat.omm, anchorMs),
      );
      return;
    }

    if (state.selectedDso) {
      const dsoId = state.selectedDso.dsoId;
      this.world.runLayerCommand(this.dsoLayer, 'requestTrail', () =>
        this.dsoLayer.requestTrail(dsoId),
      );
      return;
    }

    this.world.runLayerCommand(this.trailsLayer, 'clear', () => this.trailsLayer.clear());
  }

  /** Called by store actions on rate change, jumpTo, or reset. */
  private onSimTimeJump(): void {
    // SGP4: immediate snap + reset interpolation tween (handled in the layer)
    this.world.runLayerCommand(this.satellitesLayer, 'requestImmediateSnap', () =>
      this.satellitesLayer.requestImmediateSnap(),
    );

    // Immediate DSO tick at new sim-time
    this.world.runLayerCommand(this.dsoLayer, 'triggerImmediateTick', () =>
      this.dsoLayer.triggerImmediateTick(simClock.now()),
    );

    // Refresh orbit trails at new time
    this.refreshOrbitTrail(useStore.getState());

    // Bind the loaded catalog to the (possibly new) view-time day.
    this.reconcileCatalogForTime();
  }

  // ── Historical time-scrub (A6) + planetarium / glide (Pass 2) ───────────────

  /** What the catalog SHOULD show for the current view-time. */
  private computeTarget(): CatalogTarget {
    const cov = useStore.getState().historyCoverage;
    const today = utcDay(Date.now());
    // Live TLEs are only meaningful (and cheap to propagate) near their epoch. Beyond a
    // forward horizon, satellites go planetarium (sky only) — symmetric with the past,
    // and keeps far-future times out of the SGP4 worker. See @orbitwatch/orbital-core propagation-window.ts.
    const horizon = utcDay(Date.now() + FUTURE_HORIZON_DAYS * MS_PER_DAY);
    const t = utcDay(simClock.now());
    if (t > horizon) return { kind: 'hidden' };                   // beyond forward horizon → planetarium
    if (t >= today) return { kind: 'live' };                      // today .. +horizon → current elements
    if (!cov || !cov.from || !cov.to) return { kind: 'hidden' };  // no history → planetarium
    if (t < cov.from) return { kind: 'hidden' };                  // before coverage → planetarium
    if (t > cov.to) return { kind: 'live' };                      // recent gap not yet ingested → current
    return { kind: 'day', day: t };                               // covered past day
  }

  /** Stable comparison key for a target (so scrubbing across uncovered days never churns). */
  private static targetKey(t: CatalogTarget): string {
    return t.kind === 'day' ? t.day : t.kind;
  }

  /** The UTC day the loaded catalog is valid for, or null when hidden (→ never snap). */
  private loadedDayForSnap(): string | null {
    const lt = this.loadedTarget;
    if (lt.kind === 'hidden') return null;
    if (lt.kind === 'day') return lt.day;
    return utcDay(Date.now()); // live
  }

  /**
   * Bind the loaded catalog to the view-time. Cheap + debounced: if the desired
   * target differs from what's loaded, schedule a re-seed once the scrub settles
   * (also coalesces play/glide-driven crossings ticked from the loop).
   */
  private reconcileCatalogForTime(): void {
    if (this.isDisposed || this.criticalFailed) return;
    // Defer while a wheel scrub is active: reseed on settle, never mid-drag. Every
    // caller (loop, onSimTimeJump, the pause on grab) funnels through here, so the
    // single guard covers them all.
    if (performance.now() - this.lastScrubAt < Engine.RESEED_DEBOUNCE_MS) return;
    if (Engine.targetKey(this.computeTarget()) === Engine.targetKey(this.loadedTarget)) return;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.runReseedToDesired();
    }, Engine.RESEED_DEBOUNCE_MS);
  }

  private async runReseedToDesired(): Promise<void> {
    if (this.isReseeding || this.isDisposed || this.criticalFailed) return;
    const target = this.computeTarget();
    if (Engine.targetKey(target) === Engine.targetKey(this.loadedTarget)) return;

    this.isReseeding = true;
    try {
      if (target.kind === 'live') await this.reseedToLive();
      else if (target.kind === 'hidden') this.applyHidden();
      else await this.reseedToDay(target.day);
    } catch (err) {
      console.error('History catalog re-seed failed:', err);
    } finally {
      this.isReseeding = false;
      // Time may have moved during the await → re-check.
      if (
        !this.isDisposed &&
        Engine.targetKey(this.computeTarget()) !== Engine.targetKey(this.loadedTarget)
      ) {
        this.reconcileCatalogForTime();
      }
    }
  }

  private async reseedToDay(day: string): Promise<void> {
    const apiUrl = import.meta.env.VITE_API_URL ?? '';
    useStore.getState().setHistoryLoading(true);
    try {
      const result = await fetchHistoryDay(apiUrl, day);
      if (this.isDisposed) return;
      if (!result) return; // out of coverage / network failure → keep current
      this.applyCatalog(result, day);
    } finally {
      if (!this.isDisposed) useStore.getState().setHistoryLoading(false);
    }
  }

  private async reseedToLive(): Promise<void> {
    if (!this.liveResult) return;
    this.applyCatalog(this.liveResult, null);
  }

  /**
   * Planetarium: an uncovered-past view-time has no catalog → hide satellites +
   * DSOs and keep the sky (Earth/sun/stars are pure functions of the clock). The
   * worker keeps running but its render/count paths early-out while hidden
   * (SatellitesLayer.setHidden), so no stale counts leak; restoring re-seeds.
   */
  private applyHidden(): void {
    const store = useStore.getState();

    this.world.runLayerCommand(this.satellitesLayer, 'setHidden', () =>
      this.satellitesLayer.setHidden(true),
    );
    this.world.runLayerCommand(this.dsoLayer, 'setHidden', () => this.dsoLayer.setHidden(true));
    this.gpuPicker?.setCatalogSize(0);

    // Nothing is selectable / trackable in the planetarium past. Stash the selection
    // so returning to a catalog can re-resolve it by noradId.
    const selectedNorad = store.selectedSatellite?.noradId ?? null;
    if (selectedNorad !== null) this.pendingSelectionNorad = selectedNorad;
    this.catalogData = [];
    this.inputManager?.setCatalogData([]);
    store.setSelectedSatellite(null, null);
    store.setSelectedDso(null);
    store.setCatalogData([]);
    store.setCatalogInfo({
      objectCount: 0,
      categoryCounts: {
        active_satellite: 0,
        inactive_satellite: 0,
        rocket_body: 0,
        debris: 0,
        unknown: 0,
        deep_space: 0,
      },
      regimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },
    });

    this.loadedTarget = { kind: 'hidden' };
    store.setHistoryDay(null);
    store.setPlanetarium(true);
    this.refreshOrbitTrail();
  }

  /**
   * Swap the rendered catalog (live ↔ a historical day). Reuses the A1–A5 re-seed
   * primitives, re-resolves the selection by noradId so "follow" survives the swap,
   * and hides DSOs (current missions) while reviewing the past.
   */
  private applyCatalog(result: TleCatalogResult, day: string | null): void {
    const { catalogData, tles, categoryCounts, regimeCounts, facetCounts } = result;
    const store = useStore.getState();

    // Capture selection (re-resolved by noradId) + trail intent BEFORE the swap.
    // Fall back to the planetarium-stashed selection so it survives a void round-trip.
    const prevNorad = store.selectedSatellite?.noradId ?? this.pendingSelectionNorad;
    this.pendingSelectionNorad = null;
    const prevShowTrail = store.showOrbitTrail;
    const prevAltitude = store.selectedAltitude;

    // Coming back from the planetarium (hidden) → make the point cloud visible again.
    this.world.runLayerCommand(this.satellitesLayer, 'setHidden', () =>
      this.satellitesLayer.setHidden(false),
    );

    // Catalog swap (Engine-held + input + the per-frame TrackingSource read this).
    this.catalogData = catalogData;
    this.inputManager?.setCatalogData(catalogData);

    // Render plane: renderer reinit (clears any ghost tail) + worker re-INIT (snaps).
    this.world.runLayerCommand(this.satellitesLayer, 'reseed', () =>
      this.satellitesLayer.reseedCatalog(catalogData, tles),
    );

    // Picker: TLE index space resized (geometry is shared + stable).
    this.gpuPicker?.setCatalogSize(catalogData.length);

    // DSOs are current missions (ephemeris ~now) → hidden whenever the view-time is in
    // the past (a covered day OR the recent gap shown with live elements), shown at now/future.
    const isPast = utcDay(simClock.now()) < utcDay(Date.now());
    this.world.runLayerCommand(this.dsoLayer, 'setHidden', () => this.dsoLayer.setHidden(isPast));

    // Store: catalog + counts so HUD / search / filters reflect the viewed day.
    store.setCatalogData(catalogData);
    store.setCatalogInfo({ objectCount: catalogData.length, categoryCounts, regimeCounts, facetCounts });

    // Index-stability: the object set changes per day → re-resolve the selection by
    // noradId. Following continues (nav reads selectedIndex live); preserve trail.
    if (prevNorad !== null) {
      const newIndex = catalogData.findIndex((o) => o.noradId === prevNorad);
      if (newIndex >= 0) {
        store.setSelectedSatellite(newIndex, catalogData[newIndex], prevAltitude);
        if (prevShowTrail) store.setShowOrbitTrail(true);
      } else {
        store.setSelectedSatellite(null, null);
      }
    }

    this.loadedTarget = day !== null ? { kind: 'day', day } : { kind: 'live' };
    store.setHistoryDay(day);
    store.setPlanetarium(false);

    // Regenerate the orbit trail for the (re-resolved) selection at the new time.
    this.refreshOrbitTrail();
  }

  // ── Scrub preview + return-to-present glide (Pass 2) ─────────────────────────

  /**
   * Day-aware throttled snap shared by the wheel scrub-preview and the glide: if the
   * view-time is within the loaded catalog's day, snap satellites (they track the
   * scrub); otherwise leave them be (the sky still moves) — the heavy reseed happens
   * on settle / glide completion.
   */
  private softPropagateForScrub(): void {
    const d = this.loadedDayForSnap();
    if (d === null) return; // hidden → planetarium, no satellites
    if (utcDay(simClock.now()) !== d) return; // out of the loaded day → sky-only
    const now = performance.now();
    if (now - this.lastScrubSnapAt < Engine.SCRUB_SNAP_MIN_MS) return;
    this.lastScrubSnapAt = now;
    this.world.runLayerCommand(this.satellitesLayer, 'requestImmediateSnap', () =>
      this.satellitesLayer.requestImmediateSnap(),
    );
  }

  /** Store hook during a wheel drag: the sky already follows simClock; nudge satellites. */
  private onScrubPreview(): void {
    if (this.isDisposed || this.criticalFailed) return;
    // Mark active scrubbing so the loop defers reseeds until the drag settles.
    this.lastScrubAt = performance.now();
    this.softPropagateForScrub();
  }

  /** Begin the eased "return to present" glide (advanced by the rAF loop). */
  private startGlideToLive(): void {
    if (this.isDisposed || this.criticalFailed) return;
    const fromMs = simClock.now();
    // Already essentially live → snap (skip a pointless ~1.2s no-op glide).
    if (Math.abs(Date.now() - fromMs) < 1000) {
      useStore.getState().goLive();
      return;
    }
    this.glide = { fromMs, startedAt: performance.now(), durationMs: Engine.GLIDE_DURATION_MS };
  }

  /** Advance the glide one frame (called from the loop, before anything reads the clock). */
  private tickGlide(): void {
    const g = this.glide;
    if (!g) return;
    const p = Math.min((performance.now() - g.startedAt) / g.durationMs, 1);
    const e = easeInOutCubic(p);
    const t = g.fromMs + (Date.now() - g.fromMs) * e; // ease toward the moving live edge
    simClock.jumpTo(new Date(t));
    this.softPropagateForScrub();

    // Push the UI mirror on a dedicated throttle so the live edge keeps ticking too.
    const wallNow = performance.now();
    if (wallNow - this.lastGlideUiAt > 100) {
      const store = useStore.getState();
      store.setSimTimeMs(simClock.now());
      store.setWallClockMs(Date.now());
      this.lastGlideUiAt = wallNow;
    }

    if (p >= 1) {
      this.glide = null;
      // Snap exactly to live (rate 1, viewMode live) + reseed the live catalog NOW —
      // don't wait on the debounced reconcile, so satellites repaint immediately on land.
      useStore.getState().goLive();
      void this.runReseedToDesired();
    }
  }

  start(): void {
    // A critical layer that died during construction already tore everything
    // down — don't spin up a render loop over a dead engine.
    if (this.criticalFailed) return;
    this.clock.start();
    this.loop();
  }

  /**
   * A critical layer (satellites = the product) failed — at init OR at runtime.
   * Show the error and tear down the infrastructure that holds references to the
   * now-disposed satellite renderer (the GPU picker + input listeners) and stop
   * the render loop, so nothing touches freed GL after the failure. Idempotent.
   * (World disposes the failed layer itself; this handles the Engine-owned
   * consumers World can't see.)
   */
  private handleCriticalError(err: unknown): void {
    if (this.criticalFailed) return;
    this.criticalFailed = true;

    useStore.getState().setLoadingError(
      err instanceof Error ? err.message : 'A critical layer failed',
    );

    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.inputManager?.dispose();
    this.inputManager = null;
    this.gpuPicker?.dispose();
    this.gpuPicker = null;
  }

  private loop = (): void => {
    this.animationId = requestAnimationFrame(this.loop);
    const delta = this.clock.getDelta();

    // Pass 2: advance the "return to present" glide (eases simClock toward now)
    // BEFORE anything this frame reads the clock.
    if (this.glide) this.tickGlide();

    const now = simClock.date();

    const sunDir = getSunDirection(now);
    const gast = gmst(now.getTime());

    // GPU-side interpolation factor for TLE positions (owned by SatellitesLayer).
    const uT = this.satellitesLayer.getInterpolationFactor();

    // Camera state machine runs FIRST so the frame carries this-frame camera
    // position/distance (Earth/DSO LOD + label projection) and the freshest
    // selection arrival time for the satellite glow.
    this.nav.update(uT);
    const arrivalTime = this.nav.getArrivalTime();
    const selectionTimeSinceArrival = arrivalTime > 0
      ? (performance.now() - arrivalTime) / 1000
      : -1.0;

    // Per-frame context shared by all registered layers (Slice 5).
    const navState = useStore.getState();
    const frame: FrameContext = {
      date: now,
      nowMs: simClock.now(),
      delta,
      uT,
      pixelRatio: this.renderer.getPixelRatio(),
      cameraDistance: this.camera.position.length(),
      sunDirectionECI: sunDir,
      gastRadians: gast,
      isJoyrideTracking:
        navState.cameraMode === 'following' && navState.trackingStyle === 'joyride',
      selectionTimeSinceArrival,
    };
    this.world.update(frame);

    // Push sim-time to store at ~4Hz for UI (HUD, TimeScrubber)
    const wallNow = performance.now();
    if (wallNow - this.lastSimTimeUpdateAt > 250) {
      const store = useStore.getState();
      store.setSimTimeMs(simClock.now());
      store.setWallClockMs(Date.now()); // the always-advancing live edge
      this.lastSimTimeUpdateAt = wallNow;
      // Play-driven day crossings: bind the catalog to the advancing view-time.
      // (reconcile internally defers mid-scrub → reseed on settle; suppressed mid-glide.)
      if (!this.glide) this.reconcileCatalogForTime();
    }

    this.renderer.render(this.scene, this.camera);
  };

  private onResize = (): void => {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.instance.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.cameraRig.resize(width, height);
    this.renderer.setSize(width, height);
  };

  dispose(): void {
    this.isDisposed = true;
    if (import.meta.env.DEV) {
      delete (window as unknown as Record<string, unknown>).__resident;
    }
    this.residentSet.clear();
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    stopDsoClient();
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.visualListPoller?.dispose();
    this.nav.dispose();
    this.trailUnsub?.();
    this.inputManager?.dispose();
    this.resizeObserver?.disconnect();
    // GPU picker references the satellite renderer's geometry — dispose it before
    // World disposes the SatellitesLayer.
    this.gpuPicker?.dispose();
    this.world.dispose();
    this.cameraRig.dispose();
    this.renderer.dispose();
  }
}
