import { FUTURE_HORIZON_DAYS } from '@orbitwatch/orbital-core';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore } from '../../store/useStore';
import { simClock } from '../../time/SimClock';
import { fetchHistoryCoverage, fetchHistoryDay, utcDay } from '../../data/history-client';
import type { TleCatalogResult } from '../../data/tle-client';
import { getReplayClient, type ReplayClient } from '../../data/replay-client';
import { buildReplayResult, fragmentIds, REPLAY_MAX_TSINCE_MIN } from '../../data/replay-catalog';
import { computeCatalogTarget, prefetchNeighbour, targetKey, type CatalogTarget } from './timeline-target';
import { easeInOutCubic } from '../easing';

/**
 * What the TimelineController needs from the Engine. Keeps the controller free of
 * layer / picker / input imports (those are Engine-owned and reached via this seam).
 */
export interface TimelineHost {
  /** Engine has been disposed. */
  isDisposed(): boolean;
  /** disposed || a critical layer failed — public entry points early-out on this. */
  isHalted(): boolean;
  /**
   * The loaded catalog changed (boot, swap, or emptied for the planetarium). Engine
   * fans this to inputManager.setCatalogData + gpuPicker.setCatalogSize(length).
   * Also re-syncs the DSO pick IDs (encoded above the TLE count) — DSOs are never
   * hidden by a swap. The controller's own catalog is already assigned.
   */
  onCatalogSwapped(catalog: EnrichedTLEObject[]): void;
  satellitesSetHidden(hidden: boolean): void;
  /** `maxTsinceMin` widens the worker's propagation window (replay catalogs); omitted = live default. */
  satellitesReseed(catalog: EnrichedTLEObject[], tles: TleCatalogResult['tles'], maxTsinceMin?: number): void;
  satellitesSnap(): void;
  refreshOrbitTrail(): void;
}

/**
 * Catalog lifecycle across time: historical time-scrub (A6), planetarium (hidden
 * catalog) and the eased return-to-present glide (Pass 2). Single owner of the
 * Engine-side loaded catalog.
 */
export class TimelineController {
  /** Debounce window before a settled scrub triggers a catalog re-seed. */
  private static readonly RESEED_DEBOUNCE_MS = 200;
  /** "Return to present" glide duration. */
  private static readonly GLIDE_DURATION_MS = 1200;
  /** Min gap between scrub/glide-driven satellite snaps (~11 Hz). */
  private static readonly SCRUB_SNAP_MIN_MS = 90;

  private readonly apiUrl: string;
  private readonly host: TimelineHost;
  /** History REPLAY archive client (/api/history/range, /catalog). */
  private readonly replay: ReplayClient;

  /** The catalog currently loaded in the render plane (Engine-side single owner). */
  private catalogData: EnrichedTLEObject[] = [];
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
  /** Replay target whose day could not be served (archive gap / 404 / 503): shown as planetarium, not retried every tick. */
  private missingKey: string | null = null;

  constructor({ apiUrl, host, replay }: { apiUrl: string; host: TimelineHost; replay?: ReplayClient }) {
    this.apiUrl = apiUrl;
    this.host = host;
    this.replay = replay ?? getReplayClient(apiUrl);
  }

  /** The currently loaded catalog (index space for picking / tracking / trails). */
  getCatalog(): EnrichedTLEObject[] {
    return this.catalogData;
  }

  isGliding(): boolean {
    return this.glide !== null;
  }

  /**
   * Boot: install the live catalog (cached for instant return to "now") and probe
   * history coverage (non-blocking) to bound the scrubber later.
   */
  installLive(result: TleCatalogResult): void {
    this.catalogData = result.catalogData;
    this.host.onCatalogSwapped(this.catalogData);

    this.liveResult = result;
    void fetchHistoryCoverage(this.apiUrl).then((cov) => {
      if (!this.host.isDisposed()) useStore.getState().setHistoryCoverage(cov);
    });
    // Replay archive span (null on 503 → the date picker offers only the live range).
    void this.replay.range().then((range) => {
      if (!this.host.isDisposed()) useStore.getState().setReplayRange(range);
    });
  }

  /** What the catalog SHOULD show for the current view-time. */
  private computeTarget(): CatalogTarget {
    const store = useStore.getState();
    return computeCatalogTarget({
      simMs: simClock.now(),
      wallMs: Date.now(),
      coverage: store.historyCoverage,
      futureHorizonDays: FUTURE_HORIZON_DAYS,
      replayRange: store.replayRange,
    });
  }

  /** The UTC day the loaded catalog is valid for, or null when hidden (→ never snap). */
  private loadedDayForSnap(): string | null {
    const lt = this.loadedTarget;
    if (lt.kind === 'hidden') return null;
    if (lt.kind === 'day' || lt.kind === 'replay') return lt.day;
    return utcDay(Date.now()); // live
  }

  /**
   * Bind the loaded catalog to the view-time. Cheap + debounced: if the desired
   * target differs from what's loaded, schedule a re-seed once the scrub settles
   * (also coalesces play/glide-driven crossings ticked from the loop).
   */
  reconcileCatalogForTime(): void {
    if (this.host.isHalted()) return;
    // Defer while a wheel scrub is active: reseed on settle, never mid-drag. Every
    // caller (loop, onSimTimeJump, the pause on grab) funnels through here, so the
    // single guard covers them all.
    if (performance.now() - this.lastScrubAt < TimelineController.RESEED_DEBOUNCE_MS) return;
    // Replay: keep the next day (in playback direction) warm so the midnight swap is instant.
    if (this.loadedTarget.kind === 'replay') this.prefetchAround(this.loadedTarget.day);
    if (this.isSettled(this.computeTarget())) return;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.runReseedToDesired();
    }, TimelineController.RESEED_DEBOUNCE_MS);
  }

  private async runReseedToDesired(): Promise<void> {
    if (this.isReseeding || this.host.isHalted()) return;
    const target = this.computeTarget();
    if (this.isSettled(target)) return;

    this.isReseeding = true;
    try {
      if (target.kind === 'live') await this.reseedToLive();
      else if (target.kind === 'hidden') this.applyHidden();
      else if (target.kind === 'replay') await this.reseedToReplayDay(target.day);
      else await this.reseedToDay(target.day);
    } catch (err) {
      console.error('History catalog re-seed failed:', err);
    } finally {
      this.isReseeding = false;
      // Time may have moved during the await → re-check.
      if (!this.host.isDisposed() && !this.isSettled(this.computeTarget())) {
        this.reconcileCatalogForTime();
      }
    }
  }

  /** Nothing to do for `target`: it is loaded, or it is the replay day known to be unavailable. */
  private isSettled(target: CatalogTarget): boolean {
    const key = targetKey(target);
    return key === targetKey(this.loadedTarget) || key === this.missingKey;
  }

  private async reseedToDay(day: string): Promise<void> {
    useStore.getState().setHistoryLoading(true);
    try {
      const result = await fetchHistoryDay(this.apiUrl, day);
      if (this.host.isDisposed()) return;
      if (!result) return; // out of coverage / network failure → keep current
      this.applyCatalog(result, day);
    } finally {
      if (!this.host.isDisposed()) useStore.getState().setHistoryLoading(false);
    }
  }

  /**
   * History REPLAY: install the archive catalog as of the end of `day`. Coming from
   * another replay day the new objects are laid out in the previous slots
   * (stableOrder) so survivors keep their index — the swap at midnight is
   * continuous — and the selection is re-resolved by noradId as for every swap.
   */
  private async reseedToReplayDay(day: string): Promise<void> {
    const instant = this.replay.hasInMemory(day);
    if (!instant) useStore.getState().setHistoryLoading(true);
    try {
      const body = await this.replay.catalog(day);
      if (this.host.isDisposed()) return;
      // Time may have moved on while fetching (scrub) → only install if still wanted.
      const now = this.computeTarget();
      if (now.kind !== 'replay' || now.day !== day) return;
      if (!body) {
        // A day the archive cannot serve (gap / 404 / 503): sky only, like any uncovered past.
        if (this.loadedTarget.kind !== 'hidden') this.applyHidden();
        this.missingKey = targetKey(now);
        return;
      }
      const prev = this.loadedTarget.kind === 'replay' ? this.catalogData : undefined;
      const built = buildReplayResult(body, prev);
      this.applyCatalog(built.result, day, { replay: true });
      useStore.getState().setReplayLoaded({ day, accuracy: built.accuracy, sgpCount: built.sgpCount });
      this.reapplyFragments();
      this.prefetchAround(day);
    } finally {
      if (!instant && !this.host.isDisposed()) useStore.getState().setHistoryLoading(false);
    }
  }

  /** Warm the neighbouring replay day in the playback direction (no-op when cached). */
  private prefetchAround(day: string): void {
    const store = useStore.getState();
    const next = prefetchNeighbour(day, store.simRate, store.replayRange);
    if (next) this.replay.prefetch(next);
  }

  /**
   * "Show fragments" survives day swaps: re-derive the pieces of the launch from the
   * newly loaded catalog (later-catalogued pieces join). Cleared filter = mode off.
   */
  private reapplyFragments(): void {
    const store = useStore.getState();
    const f = store.replayFragments;
    if (!f) return;
    if (store.analyticFilter.mode === 'all') {
      store.setReplayFragments(null);
      return;
    }
    store.setAnalyticFilter(fragmentIds(this.catalogData, f.launches, f.parentNorads));
  }

  /** Leaving replay ends "show fragments" (its filter belongs to archive days). */
  private dropFragments(): void {
    const store = useStore.getState();
    if (!store.replayFragments) return;
    store.setReplayFragments(null);
    store.setAnalyticFilter(null);
  }

  private async reseedToLive(): Promise<void> {
    if (!this.liveResult) return;
    this.applyCatalog(this.liveResult, null);
  }

  /**
   * Planetarium: an uncovered-past view-time has no catalog → hide satellites and
   * keep the sky (Earth/sun/stars are pure functions of the clock). DSOs stay: they
   * show by their own ephemeris window, and the selected DSO is kept. The
   * worker keeps running but its render/count paths early-out while hidden
   * (SatellitesLayer.setHidden), so no stale counts leak; restoring re-seeds.
   */
  private applyHidden(): void {
    const store = useStore.getState();

    // Nothing is selectable / trackable in the planetarium past. Stash the selection
    // so returning to a catalog can re-resolve it by noradId.
    const selectedNorad = store.selectedSatellite?.noradId ?? null;
    if (selectedNorad !== null) this.pendingSelectionNorad = selectedNorad;
    // Own catalog is emptied BEFORE any layer/store write (the DSO re-sync reads it).
    this.catalogData = [];

    this.host.satellitesSetHidden(true);
    this.host.onCatalogSwapped(this.catalogData); // picker size 0 + input empty

    store.setSelectedSatellite(null, null);
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
    store.setReplayLoaded({ day: null, accuracy: null, sgpCount: 0 });
    this.dropFragments();
    store.setPlanetarium(true);
    this.host.refreshOrbitTrail();
  }

  /**
   * Swap the rendered catalog (live ↔ a historical day). Reuses the A1–A5 re-seed
   * primitives, re-resolves the selection by noradId so "follow" survives the swap,
   * DSOs are left alone (they follow their own ephemeris window).
   */
  private applyCatalog(result: TleCatalogResult, day: string | null, opts: { replay?: boolean } = {}): void {
    const { catalogData, tles, categoryCounts, regimeCounts, facetCounts } = result;
    const store = useStore.getState();

    // Capture selection (re-resolved by noradId) + trail intent BEFORE the swap.
    // Fall back to the planetarium-stashed selection so it survives a void round-trip.
    const prevNorad = store.selectedSatellite?.noradId ?? this.pendingSelectionNorad;
    this.pendingSelectionNorad = null;
    const prevShowTrail = store.showOrbitTrail;
    const prevAltitude = store.selectedAltitude;

    // Coming back from the planetarium (hidden) → make the point cloud visible again.
    this.host.satellitesSetHidden(false);

    // Catalog swap (owned here; the per-frame TrackingSource + DSO layer read it).
    this.catalogData = catalogData;

    // Render plane: renderer reinit (clears any ghost tail) + worker re-INIT (snaps).
    this.host.satellitesReseed(catalogData, tles, opts.replay ? REPLAY_MAX_TSINCE_MIN : undefined);

    // Input + picker: TLE index space resized (geometry is shared + stable).
    this.host.onCatalogSwapped(this.catalogData);

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

    this.loadedTarget = day === null ? { kind: 'live' } : opts.replay ? { kind: 'replay', day } : { kind: 'day', day };
    this.missingKey = null;
    store.setHistoryDay(day);
    if (!opts.replay) {
      store.setReplayLoaded({ day: null, accuracy: null, sgpCount: 0 });
      this.dropFragments();
    }
    store.setPlanetarium(false);

    // Regenerate the orbit trail for the (re-resolved) selection at the new time.
    this.host.refreshOrbitTrail();
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
    if (now - this.lastScrubSnapAt < TimelineController.SCRUB_SNAP_MIN_MS) return;
    this.lastScrubSnapAt = now;
    this.host.satellitesSnap();
  }

  /** Store hook during a wheel drag: the sky already follows simClock; nudge satellites. */
  onScrubPreview(): void {
    if (this.host.isHalted()) return;
    // Mark active scrubbing so the loop defers reseeds until the drag settles.
    this.lastScrubAt = performance.now();
    this.softPropagateForScrub();
  }

  /** Begin the eased "return to present" glide (advanced by the rAF loop). */
  startGlideToLive(): void {
    if (this.host.isHalted()) return;
    const fromMs = simClock.now();
    // Already essentially live → snap (skip a pointless ~1.2s no-op glide).
    if (Math.abs(Date.now() - fromMs) < 1000) {
      useStore.getState().goLive();
      return;
    }
    this.glide = {
      fromMs,
      startedAt: performance.now(),
      durationMs: TimelineController.GLIDE_DURATION_MS,
    };
  }

  /**
   * rAF hook: advance the glide one frame if active (call before anything in the
   * frame reads the clock).
   */
  tickFrame(): void {
    if (this.glide) this.tickGlide();
  }

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

  dispose(): void {
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }
}
