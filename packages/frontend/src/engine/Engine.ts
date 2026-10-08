import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getSunDirection } from './scene/sky';
import { gmst } from '@orbitwatch/orbital-core';
import type { VisualListResolvedResult } from '../data/visualList';
import { VisualListPoller, buildCatalogResult } from '../data/tle-client';
import { bootstrapCatalog } from '../data/bootstrapCatalog';
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
import { TimelineController } from './controllers/TimelineController';

export class Engine {
  private static readonly EMPTY_NORAD_SET: Set<number> = new Set();

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
  /** Historical time-scrub / planetarium / return-to-present; owns the loaded catalog. */
  private timeline: TimelineController;

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

    // ── Timeline (historical scrub / planetarium / glide; owns the catalog) ───
    this.timeline = new TimelineController({
      apiUrl: import.meta.env.VITE_API_URL ?? '',
      host: {
        isDisposed: () => this.isDisposed,
        isHalted: () => this.isDisposed || this.criticalFailed,
        onCatalogSwapped: (catalog) => {
          this.inputManager?.setCatalogData(catalog);
          this.gpuPicker?.setCatalogSize(catalog.length);
        },
        satellitesSetHidden: (hidden) =>
          this.world.runLayerCommand(this.satellitesLayer, 'setHidden', () =>
            this.satellitesLayer.setHidden(hidden),
          ),
        satellitesReseed: (catalog, tles) =>
          this.world.runLayerCommand(this.satellitesLayer, 'reseed', () =>
            this.satellitesLayer.reseedCatalog(catalog, tles),
          ),
        satellitesSnap: () =>
          this.world.runLayerCommand(this.satellitesLayer, 'requestImmediateSnap', () =>
            this.satellitesLayer.requestImmediateSnap(),
          ),
        dsoSetHidden: (hidden) =>
          this.world.runLayerCommand(this.dsoLayer, 'setHidden', () =>
            this.dsoLayer.setHidden(hidden),
          ),
        refreshOrbitTrail: () => this.refreshOrbitTrail(),
      },
    });

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

      // Install the live catalog in the timeline (owns it; fans to input/picker via
      // onCatalogSwapped), cache it for instant return to "now", probe history coverage.
      this.timeline.installLive(buildCatalogResult(catalogData));

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
          getTleCount: () => this.timeline.getCatalog().length,
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
      getTleCount: () => this.timeline.getCatalog().length,
      getTleObject: (index) => this.timeline.getCatalog()[index],
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
      scrubPreview: () => this.timeline.onScrubPreview(),
      returnToPresent: () => this.timeline.startGlideToLive(),
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
    const catalog = this.timeline.getCatalog();
    if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < catalog.length) {
      const sat = catalog[selectedIndex];
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
    this.timeline.reconcileCatalogForTime();
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
    this.timeline.tickFrame();

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
      if (!this.timeline.isGliding()) this.timeline.reconcileCatalogForTime();
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
    this.timeline.dispose();
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
