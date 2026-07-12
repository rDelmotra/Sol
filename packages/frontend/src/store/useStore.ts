import { create } from 'zustand';
import type { EnrichedTLEObject, ObjectCategory, OrbitalRegime, CatalogType, FacetCounts } from '../data/types';
import { emptyFacetCounts, cloneFacetCounts } from '../data/types';
import type { Purpose, SectorFilterKey, OrbitalStatus } from '../data/metadata-types';
import type { DsoObject, DsoSnapshot } from '../data/dso-types';
import type { VisualListSource, VisualListStatus } from '../data/visualList';
import type { HistoryCoverage } from '../data/history-client';
import type { DsoLabelPosition } from '../engine/DsoRenderer';
import { simClock } from '../engine/SimClock';
import { reconcileFilterSlices } from '../query/apply';
import type { QueryFilterPatch } from '../query/types';

export type LoadingPhase = 'fetching' | 'initializing' | 'propagating' | 'ready';
export type CameraMode = 'free' | 'flying' | 'following' | 'returning';
export type TrackingStyle = 'follow' | 'joyride';
export type VisibilityMode = 'all' | 'radio' | 'dome';
/** Live = view-clock tracks wall-clock now; Review = scrubbed/playing away from now. */
export type ViewMode = 'live' | 'review';

/** Visibility modes that drive the observer-anchored sky camera (vs the globe view). */
export function isObserverMode(mode: VisibilityMode): boolean {
  return mode === 'dome';
}

/**
 * True only while the camera is actually in the dome observer view — standing on the
 * ground looking up: `free` camera + `dome` mode + a known observer location. Joyride
 * and fly-to flip `cameraMode` away from `free` (the observer rig exits), so this gates
 * the dome **visuals** (gradient sky, hidden Earth surface, compass) off and restores
 * the normal space view — keeping visuals in lockstep with the camera, no race.
 */
export function isDomeView(s: {
  cameraMode: CameraMode;
  visibilityMode: VisibilityMode;
  observerLocation: { lat: number; lon: number; alt: number } | null;
}): boolean {
  return s.cameraMode === 'free' && s.visibilityMode === 'dome' && s.observerLocation !== null;
}

export interface VisualListState {
  status: VisualListStatus;
  version: string | null;
  source: VisualListSource;
  stale: boolean;
  count: number;
  updatedAt: number | null;
  message: string | null;
}

// ── Rich-metadata facets (Phase B) ────────────────────────────────────────────
// Added ALONGSIDE the legacy category/regime filter surface; the legacy fields
// are retired in B5–B7 once the renderer + UI read these instead.

/** Dimension the satellite point cloud is colored by (drives the Legend + palette). */
export type ColorBy = 'type' | 'status' | 'sector' | 'country';

/** Country filter: every operator, or only an explicit allow-set of canonical codes. */
export type CountryFilter = { mode: 'all' } | { mode: 'only'; codes: Set<string> };

/** Program filter: every object, or only members of an allow-set of program slugs.
 *  Query-only for now — the FilterPanel has no program group yet. */
export type ProgramFilter = { mode: 'all' } | { mode: 'only'; ids: Set<string> };

/** Launch filter (query-only, G3): every object, or only those from an allow-set
 *  of GCAT launch tags — the compiled target of vehicle/site/launch/year facets. */
export type LaunchFilter = { mode: 'all' } | { mode: 'only'; tags: Set<string> };

/** Owner filter (query-only, G3): every object, or only those owned by an allow-set
 *  of GCAT org codes — the compiled target of the operator facet. */
export type OwnerFilter = { mode: 'all' } | { mode: 'only'; codes: Set<string> };

/** Analytic result filter (P1): every object, or only the noradIds an Analytic IR
 *  program returned. Set via setAnalyticFilter, NOT the query-patch reconcile path —
 *  programs run once per ask, so there is no keystroke churn to dedupe. */
export type AnalyticFilter = { mode: 'all' } | { mode: 'only'; ids: Set<number> };

/**
 * The slice of state the satellite render-side filter pass reads. The full store
 * state structurally satisfies this, so callers pass `useStore.getState()` directly.
 */
export interface SatelliteFilterState {
  typeFilters: Record<CatalogType, boolean>;
  statusFilters: Record<OrbitalStatus, boolean>;
  sectorFilters: Record<SectorFilterKey, boolean>;
  purposeFilters: Record<Purpose, boolean>;
  countryFilter: CountryFilter;
  programFilter: ProgramFilter;
  regimeFilters: Record<OrbitalRegime, boolean>;
  launchFilter: LaunchFilter;   // G3
  ownerFilter: OwnerFilter;     // G3
  analyticFilter: AnalyticFilter; // P1 — analytic program allow-set
}

const ALL_TYPE_ON: Record<CatalogType, boolean> = {
  satellite: true, rocket_body: true, debris: true, unknown: true, deep_space: true,
};
const ALL_STATUS_ON: Record<OrbitalStatus, boolean> = {
  in_orbit: true, decayed: true, deorbited: true, beyond_earth: true, exploded: true, unknown: true,
};
const ALL_SECTOR_ON: Record<SectorFilterKey, boolean> = {
  commercial: true, government: true, military: true, civil: true, unspecified: true,
};
const ALL_PURPOSE_ON: Record<Purpose, boolean> = {
  communications: true, earth_observation: true, navigation: true, technology_dev: true,
  space_science: true, space_observation: true, surveillance: true, meteorological: true, other: true,
};

interface AppState {
  loadingPhase: LoadingPhase;
  loadingError: string | null;
  cameraMode: CameraMode;
  trackingStyle: TrackingStyle;
  objectCount: number;
  categoryCounts: Record<ObjectCategory, number>;
  dataTimestamp: number | null;

  catalogData: EnrichedTLEObject[];
  selectByIndex: ((index: number) => void) | null;
  // Registered by SearchBar (G3): replace the search text + run the query
  // pipeline immediately. InfoCard pivots call it. null until SearchBar mounts.
  injectSearchQuery: ((text: string) => void) | null;
  triggerFlyTo: ((index: number) => void) | null;
  triggerJoyride: ((index: number) => void) | null;
  triggerResetCamera: (() => void) | null;

  selectedIndex: number | null;
  selectedSatellite: EnrichedTLEObject | null;
  selectedAltitude: number | null;
  showOrbitTrail: boolean;

  // DSO state
  dsoObjects: DsoObject[];
  dsoEphemerisById: Record<string, DsoSnapshot>;
  selectedDso: DsoObject | null;
  dsoLabelPositions: DsoLabelPosition[];
  triggerFlyToDso: ((dsoId: string) => void) | null;
  triggerJoyrideDso: ((dsoId: string) => void) | null;

  hoveredName: string | null;
  hoverScreenX: number;
  hoverScreenY: number;

  clusterItems: { index: number; data: EnrichedTLEObject; altitude: number }[];
  clusterScreenX: number;
  clusterScreenY: number;

  observerLocation: { lat: number; lon: number; alt: number } | null;
  visibilityMode: VisibilityMode;
  /** Dome-mode gaze heading (radians, from North toward East); drives the HUD compass. */
  observerHeadingRad: number;
  visualList: VisualListState;

  categoryFilters: Record<ObjectCategory, boolean>;
  regimeFilters: Record<OrbitalRegime, boolean>;
  regimeCounts: Record<OrbitalRegime, number>;
  visibleCategoryCounts: Record<ObjectCategory, number>;
  visibleRegimeCounts: Record<OrbitalRegime, number>;

  // Rich-metadata facet filters + color-by (Phase B; additive to category/regime above)
  colorBy: ColorBy;
  typeFilters: Record<CatalogType, boolean>;
  statusFilters: Record<OrbitalStatus, boolean>;
  sectorFilters: Record<SectorFilterKey, boolean>;
  purposeFilters: Record<Purpose, boolean>;
  countryFilter: CountryFilter;
  programFilter: ProgramFilter;
  launchFilter: LaunchFilter;   // G3 — query-only
  ownerFilter: OwnerFilter;     // G3 — query-only
  analyticFilter: AnalyticFilter; // P1 — set only by analytic program runs
  isCompilingQuery: boolean;
  facetCounts: FacetCounts;
  visibleFacetCounts: FacetCounts;

  setCameraMode: (mode: CameraMode) => void;
  setTrackingStyle: (style: TrackingStyle) => void;
  setTriggerFlyTo: (fn: (index: number) => void) => void;
  setTriggerJoyride: (fn: (index: number) => void) => void;
  setTriggerResetCamera: (fn: () => void) => void;
  setLoadingPhase: (phase: LoadingPhase) => void;
  setLoadingError: (error: string) => void;
  setCatalogInfo: (info: {
    objectCount: number;
    categoryCounts: Record<ObjectCategory, number>;
    regimeCounts: Record<OrbitalRegime, number>;
    facetCounts?: FacetCounts;
  }) => void;
  toggleCategoryFilter: (category: ObjectCategory) => void;
  toggleRegimeFilter: (regime: OrbitalRegime) => void;
  setVisibleCounts: (
    catCounts: Record<ObjectCategory, number>,
    regCounts: Record<OrbitalRegime, number>,
  ) => void;

  // Phase B facet actions
  setColorBy: (colorBy: ColorBy) => void;
  toggleTypeFilter: (key: CatalogType) => void;
  toggleStatusFilter: (key: OrbitalStatus) => void;
  toggleSectorFilter: (key: SectorFilterKey) => void;
  togglePurposeFilter: (key: Purpose) => void;
  setCountryFilter: (filter: CountryFilter) => void;
  /**
   * Apply a compiled query patch with OVERWRITE semantics over the seven
   * query-controlled slices (type/status/sector/purpose/regime/country/program):
   * each group becomes `patch.group ?? all-on`. FilterPanel manual toggles work
   * on top afterwards; the next query keystroke/chip-removal re-overwrites.
   * Reference identity is preserved for semantically-unchanged groups via
   * reconcileFilterSlices (query/apply.ts) — load-bearing for the
   * SatellitesLayer diff (no per-keystroke recomputes).
   */
  applyQueryFilters: (patch: QueryFilterPatch) => void;
  /** Restore all query-controlled slices to all-on / mode:'all'. */
  clearQueryFilters: () => void;
  /** Apply (or clear, with null) an analytic program's noradId allow-set. Semantic
   *  equality is checked inline so an identical re-run never triggers a recompute. */
  setAnalyticFilter: (ids: Set<number> | null) => void;
  setIsCompilingQuery: (isCompiling: boolean) => void;
  setVisibleFacetCounts: (counts: FacetCounts) => void;
  setCatalogData: (data: EnrichedTLEObject[]) => void;
  setSelectByIndex: (fn: (index: number) => void) => void;
  setInjectSearchQuery: (fn: ((text: string) => void) | null) => void;
  setSelectedSatellite: (
    index: number | null,
    data: EnrichedTLEObject | null,
    altitude?: number | null,
  ) => void;
  setShowOrbitTrail: (show: boolean) => void;
  setHover: (name: string | null, screenX?: number, screenY?: number) => void;
  setCluster: (items: { index: number; data: EnrichedTLEObject; altitude: number }[], screenX: number, screenY: number) => void;
  clearCluster: () => void;
  setObserverLocation: (loc: { lat: number; lon: number; alt: number } | null) => void;
  setVisibilityMode: (mode: VisibilityMode) => void;
  setObserverHeadingRad: (rad: number) => void;
  setVisualListState: (state: VisualListState) => void;

  // Simulation clock (UI mirrors — simClock is source of truth)
  simRate: number;
  simTimeMs: number;
  /** First-class liveness: tracking now (live) vs scrubbed/playing away (review). */
  viewMode: ViewMode;
  /** Wall-clock now (ms) — the always-advancing live edge; pushed ~4 Hz by the loop. */
  wallClockMs: number;
  /** Whether the modal time-scrubber (Star Walk wheel) is open (dims the rest of the HUD). */
  scrubberMode: boolean;
  triggerSimTimeJump: (() => void) | null;
  /** Engine hook for a light scrub preview (day-aware throttled snap), set by the Engine. */
  triggerScrubPreview: (() => void) | null;
  /** Engine hook to animate the view-clock back to now, set by the Engine. */
  triggerReturnToPresent: (() => void) | null;
  setSimRate: (rate: number) => void;
  setSimTimeMs: (ms: number) => void;
  setWallClockMs: (ms: number) => void;
  setScrubberMode: (on: boolean) => void;
  jumpToSimTime: (date: Date) => void;
  /** Scrub the view-clock to an absolute instant (enters review). */
  reviewAt: (date: Date) => void;
  /** Live scrub preview while dragging — moves the clock (sky) without the heavy snap. */
  scrubPreview: (date: Date) => void;
  /** Snap back to the live present (rate 1, view tracks now). */
  goLive: () => void;
  /** Smoothly glide back to the live present (Engine-driven; instant fallback). */
  returnToPresent: () => void;
  resetSimClock: () => void;
  setTriggerSimTimeJump: (fn: () => void) => void;
  setTriggerScrubPreview: (fn: () => void) => void;
  setTriggerReturnToPresent: (fn: () => void) => void;

  // Historical time-scrub (review plane) — UI mirrors of Engine-held state.
  historyCoverage: HistoryCoverage | null;
  historyStatus: 'unknown' | 'available' | 'unavailable';
  historyDay: string | null;     // null = live; else the loaded UTC day 'YYYY-MM-DD'
  historyLoading: boolean;
  /** True while reviewing a date with NO satellite catalog (planetarium: sky only). */
  planetarium: boolean;
  setHistoryCoverage: (coverage: HistoryCoverage | null) => void;
  setHistoryDay: (day: string | null) => void;
  setHistoryLoading: (loading: boolean) => void;
  setPlanetarium: (on: boolean) => void;

  // DSO actions
  setDsoObjects: (objects: DsoObject[]) => void;
  setDsoEphemeris: (dsoId: string, snapshot: DsoSnapshot) => void;
  setSelectedDso: (dso: DsoObject | null) => void;
  clearDsoEphemeris: (dsoId: string) => void;
  setDsoLabelPositions: (positions: DsoLabelPosition[]) => void;
  setTriggerFlyToDso: (fn: (dsoId: string) => void) => void;
  setTriggerJoyrideDso: (fn: (dsoId: string) => void) => void;
}

export const useStore = create<AppState>((set, get) => ({
  loadingPhase: 'fetching',
  loadingError: null,
  cameraMode: 'free',
  trackingStyle: 'follow',
  objectCount: 0,
  categoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  },
  dataTimestamp: null,

  catalogData: [],
  selectByIndex: null,
  injectSearchQuery: null,
  triggerFlyTo: null,
  triggerJoyride: null,
  triggerResetCamera: null,

  selectedIndex: null,
  selectedSatellite: null,
  selectedAltitude: null,
  showOrbitTrail: false,

  dsoObjects: [],
  dsoEphemerisById: {},
  selectedDso: null,
  dsoLabelPositions: [],
  triggerFlyToDso: null,
  triggerJoyrideDso: null,

  hoveredName: null,
  hoverScreenX: 0,
  hoverScreenY: 0,

  clusterItems: [],
  clusterScreenX: 0,
  clusterScreenY: 0,

  observerLocation: null,
  visibilityMode: 'all',
  observerHeadingRad: 0,
  visualList: {
    status: 'loading',
    version: null,
    source: null,
    stale: false,
    count: 0,
    updatedAt: null,
    message: null,
  },

  categoryFilters: {
    active_satellite: true,
    inactive_satellite: true,
    rocket_body: true,
    debris: true,
    unknown: true,
    deep_space: true,
  },
  regimeFilters: { LEO: true, MEO: true, GEO: true, HEO: true, OTHER: true },
  regimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },
  visibleCategoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  },
  visibleRegimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },

  colorBy: 'type',
  typeFilters: { ...ALL_TYPE_ON },
  statusFilters: { ...ALL_STATUS_ON },
  sectorFilters: { ...ALL_SECTOR_ON },
  purposeFilters: { ...ALL_PURPOSE_ON },
  countryFilter: { mode: 'all' },
  programFilter: { mode: 'all' },
  launchFilter: { mode: 'all' },
  ownerFilter: { mode: 'all' },
  analyticFilter: { mode: 'all' },
  isCompilingQuery: false,
  facetCounts: emptyFacetCounts(),
  visibleFacetCounts: emptyFacetCounts(),

  setCameraMode: (mode) => set({ cameraMode: mode }),
  setTrackingStyle: (style) => set({ trackingStyle: style }),
  setTriggerFlyTo: (fn) => set({ triggerFlyTo: fn }),
  setTriggerJoyride: (fn) => set({ triggerJoyride: fn }),
  setTriggerResetCamera: (fn) => set({ triggerResetCamera: fn }),
  setLoadingPhase: (phase) => set({ loadingPhase: phase }),
  setLoadingError: (error) => set({ loadingError: error }),
  setCatalogInfo: (info) => {
    const facetCounts = info.facetCounts ?? emptyFacetCounts();
    set({
      objectCount: info.objectCount,
      categoryCounts: info.categoryCounts,
      regimeCounts: info.regimeCounts,
      visibleCategoryCounts: { ...info.categoryCounts },
      visibleRegimeCounts: { ...info.regimeCounts },
      facetCounts,
      // At load every object is visible — seed visible = total (deep-cloned so the
      // renderer can mutate visible counts without touching the totals).
      visibleFacetCounts: cloneFacetCounts(facetCounts),
      dataTimestamp: Date.now(),
    });
  },
  toggleCategoryFilter: (category) =>
    set((state) => ({
      categoryFilters: {
        ...state.categoryFilters,
        [category]: !state.categoryFilters[category],
      },
    })),
  toggleRegimeFilter: (regime) =>
    set((state) => ({
      regimeFilters: {
        ...state.regimeFilters,
        [regime]: !state.regimeFilters[regime],
      },
    })),
  setVisibleCounts: (catCounts, regCounts) =>
    set({ visibleCategoryCounts: catCounts, visibleRegimeCounts: regCounts }),

  setColorBy: (colorBy) => set({ colorBy }),
  toggleTypeFilter: (key) =>
    set((state) => ({ typeFilters: { ...state.typeFilters, [key]: !state.typeFilters[key] } })),
  toggleStatusFilter: (key) =>
    set((state) => ({ statusFilters: { ...state.statusFilters, [key]: !state.statusFilters[key] } })),
  toggleSectorFilter: (key) =>
    set((state) => ({ sectorFilters: { ...state.sectorFilters, [key]: !state.sectorFilters[key] } })),
  togglePurposeFilter: (key) =>
    set((state) => ({ purposeFilters: { ...state.purposeFilters, [key]: !state.purposeFilters[key] } })),
  setCountryFilter: (filter) => set({ countryFilter: filter }),
  applyQueryFilters: (patch) => {
    const s = get();
    const delta = reconcileFilterSlices(
      {
        typeFilters: s.typeFilters,
        statusFilters: s.statusFilters,
        sectorFilters: s.sectorFilters,
        purposeFilters: s.purposeFilters,
        regimeFilters: s.regimeFilters,
        countryFilter: s.countryFilter,
        programFilter: s.programFilter,
        launchFilter: s.launchFilter,
        ownerFilter: s.ownerFilter,
      },
      patch,
    );
    if (Object.keys(delta).length > 0) set(delta);
  },
  clearQueryFilters: () => get().applyQueryFilters({}),
  setAnalyticFilter: (ids) => {
    const cur = get().analyticFilter;
    if (ids === null) {
      if (cur.mode !== 'all') set({ analyticFilter: { mode: 'all' } });
      return;
    }
    if (cur.mode === 'only' && cur.ids.size === ids.size) {
      let same = true;
      for (const id of ids) {
        if (!cur.ids.has(id)) { same = false; break; }
      }
      if (same) return; // reference preserved — no renderer recompute
    }
    set({ analyticFilter: { mode: 'only', ids: new Set(ids) } });
  },
  setIsCompilingQuery: (isCompiling) => set({ isCompilingQuery: isCompiling }),
  setVisibleFacetCounts: (counts) =>
    // The satellite render pass counts only TLE objects, so its type.deep_space is
    // always 0. DSOs (the only deep_space objects, owned by a separate layer) are
    // never gated by this pass → keep their count = the maintained total.
    set((state) => ({
      visibleFacetCounts: {
        ...counts,
        type: { ...counts.type, deep_space: state.facetCounts.type.deep_space },
      },
    })),
  setCatalogData: (data) => set({ catalogData: data }),
  setSelectByIndex: (fn) => set({ selectByIndex: fn }),
  setInjectSearchQuery: (fn) => set({ injectSearchQuery: fn }),
  setSelectedSatellite: (index, data, altitude) =>
    set((state) => ({
      selectedIndex: index,
      selectedSatellite: data,
      selectedAltitude: altitude ?? null,
      showOrbitTrail: false,
      // Clear DSO selection when selecting a TLE object
      ...(index !== null ? { selectedDso: null } : {}),
      // Deselecting during tracking: smooth return to Earth-centered view
      ...(index === null && (state.cameraMode === 'flying' || state.cameraMode === 'following')
        ? { cameraMode: 'returning' as CameraMode }
        : {}),
    })),
  setShowOrbitTrail: (show) => set({ showOrbitTrail: show }),
  setHover: (name, screenX, screenY) =>
    set({
      hoveredName: name,
      hoverScreenX: screenX ?? 0,
      hoverScreenY: screenY ?? 0,
    }),
  setCluster: (items, screenX, screenY) =>
    set({
      clusterItems: items,
      clusterScreenX: screenX,
      clusterScreenY: screenY,
    }),
  clearCluster: () => set({ clusterItems: [] }),
  setObserverLocation: (loc) => set({ observerLocation: loc }),
  setVisibilityMode: (mode) => set({ visibilityMode: mode }),
  setObserverHeadingRad: (rad) => set({ observerHeadingRad: rad }),
  setVisualListState: (visualList) => set({ visualList }),

  simRate: 1,
  simTimeMs: Date.now(),
  viewMode: 'live',
  wallClockMs: Date.now(),
  scrubberMode: false,
  triggerSimTimeJump: null,
  triggerScrubPreview: null,
  triggerReturnToPresent: null,
  setSimRate: (rate) =>
    set((state) => {
      simClock.setRate(rate);
      state.triggerSimTimeJump?.();
      // Leaving rate 1 means we're no longer tracking the live present.
      return {
        simRate: rate,
        simTimeMs: simClock.now(),
        viewMode: rate !== 1 ? 'review' : state.viewMode,
      };
    }),
  setSimTimeMs: (ms) => set({ simTimeMs: ms }),
  setWallClockMs: (ms) => set({ wallClockMs: ms }),
  setScrubberMode: (on) => set({ scrubberMode: on }),
  jumpToSimTime: (date) =>
    set((state) => {
      simClock.jumpTo(date);
      state.triggerSimTimeJump?.();
      return { simTimeMs: simClock.now() };
    }),
  reviewAt: (date) =>
    set((state) => {
      simClock.jumpTo(date);
      state.triggerSimTimeJump?.();
      return { simTimeMs: simClock.now(), viewMode: 'review' };
    }),
  scrubPreview: (date) =>
    set((state) => {
      // Move the view-clock (the sky follows every frame) WITHOUT the heavy snap/
      // reconcile. Satellites get a day-aware throttled snap via the Engine hook;
      // the full reseed happens on release (reviewAt).
      simClock.jumpTo(date);
      state.triggerScrubPreview?.();
      return { simTimeMs: simClock.now(), viewMode: 'review' };
    }),
  goLive: () =>
    set((state) => {
      simClock.reset();
      state.triggerSimTimeJump?.();
      return { simRate: 1, simTimeMs: simClock.now(), viewMode: 'live' };
    }),
  returnToPresent: () =>
    set((state) => {
      // Prefer the Engine's eased glide; fall back to an instant snap when no engine
      // is attached (e.g. before bootstrap). The glide calls goLive() on landing.
      if (state.triggerReturnToPresent) {
        state.triggerReturnToPresent();
        return {};
      }
      simClock.reset();
      state.triggerSimTimeJump?.();
      return { simRate: 1, simTimeMs: simClock.now(), viewMode: 'live' };
    }),
  resetSimClock: () =>
    set((state) => {
      // Thin alias of goLive — snap to the live present.
      simClock.reset();
      state.triggerSimTimeJump?.();
      return { simRate: 1, simTimeMs: simClock.now(), viewMode: 'live' };
    }),
  setTriggerSimTimeJump: (fn) => set({ triggerSimTimeJump: fn }),
  setTriggerScrubPreview: (fn) => set({ triggerScrubPreview: fn }),
  setTriggerReturnToPresent: (fn) => set({ triggerReturnToPresent: fn }),

  historyCoverage: null,
  historyStatus: 'unknown',
  historyDay: null,
  historyLoading: false,
  planetarium: false,
  setHistoryCoverage: (coverage) =>
    set({
      historyCoverage: coverage,
      historyStatus: coverage && coverage.from ? 'available' : 'unavailable',
    }),
  setHistoryDay: (day) => set({ historyDay: day }),
  setHistoryLoading: (loading) => set({ historyLoading: loading }),
  setPlanetarium: (on) => set({ planetarium: on }),

  setDsoObjects: (objects) =>
    set((state) => ({
      dsoObjects: objects,
      categoryCounts: { ...state.categoryCounts, deep_space: objects.length },
      // DSOs are the only 'deep_space' objects (TLE catalog has none) — mirror the
      // count into the new type facet (total + visible) so the type filter group agrees.
      facetCounts: {
        ...state.facetCounts,
        type: { ...state.facetCounts.type, deep_space: objects.length },
      },
      visibleFacetCounts: {
        ...state.visibleFacetCounts,
        type: { ...state.visibleFacetCounts.type, deep_space: objects.length },
      },
    })),
  setDsoEphemeris: (dsoId, snapshot) =>
    set((state) => ({
      dsoEphemerisById: { ...state.dsoEphemerisById, [dsoId]: snapshot },
    })),
  setSelectedDso: (dso) =>
    set((state) => ({
      selectedDso: dso,
      // Clear TLE selection when selecting a DSO
      ...(dso !== null
        ? { selectedIndex: null, selectedSatellite: null, selectedAltitude: null }
        : {}),
      // Deselecting during tracking: smooth return
      ...(dso === null && (state.cameraMode === 'flying' || state.cameraMode === 'following')
        ? { cameraMode: 'returning' as CameraMode }
        : {}),
    })),
  clearDsoEphemeris: (dsoId) =>
    set((state) => {
      const next = { ...state.dsoEphemerisById };
      delete next[dsoId];
      return { dsoEphemerisById: next };
    }),
  setDsoLabelPositions: (positions) => set({ dsoLabelPositions: positions }),
  setTriggerFlyToDso: (fn) => set({ triggerFlyToDso: fn }),
  setTriggerJoyrideDso: (fn) => set({ triggerJoyrideDso: fn }),
}));

