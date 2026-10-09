import type { StateCreator } from 'zustand';
import type { CatalogType, FacetCounts, GeodeticObserver } from '../data/types';
import type { EnrichedTLEObject, ObjectCategory, OrbitalRegime, Purpose, OrbitalStatus, DsoSnapshot } from '@orbitwatch/contracts';
import type { SectorFilterKey } from '../data/metadata-types';
import type { DsoObject, DsoLabelPosition } from '../data/dso-types';
import type { VisualListSource, VisualListStatus } from '../data/visualList';
import type { HistoryCoverage } from '../data/history-client';
import type { QueryFilterPatch } from '../query/types';
import type { AnalyticProgram, ExecuteOutcome, AnalyticResult } from '@orbitwatch/analytic';

/**
 * The current analytic answer (P2) — what the AnswerCard renders. One at a time;
 * asking again replaces it. `result.ids` is a Uint32Array and is never serialized,
 * so it's fine to hold in the store.
 */
export interface AnalyticAnswer {
  status: 'compiling' | 'ready' | 'error';
  question: string;
  interpretation?: string;
  result?: AnalyticResult;
  message?: string;
}

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
  observerLocation: GeodeticObserver | null;
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

// ── Slice interfaces ──────────────────────────────────────────────────────────

export interface BootSlice {
  loadingPhase: LoadingPhase;
  loadingError: string | null;
  setLoadingPhase: (phase: LoadingPhase) => void;
  setLoadingError: (error: string) => void;
}

export interface CatalogSlice {
  objectCount: number;
  categoryCounts: Record<ObjectCategory, number>;
  regimeCounts: Record<OrbitalRegime, number>;
  facetCounts: FacetCounts;
  dataTimestamp: number | null;
  catalogData: EnrichedTLEObject[];
  setCatalogInfo: (info: {
    objectCount: number;
    categoryCounts: Record<ObjectCategory, number>;
    regimeCounts: Record<OrbitalRegime, number>;
    facetCounts?: FacetCounts;
  }) => void;
  setCatalogData: (data: EnrichedTLEObject[]) => void;
}

export interface CommandSlice {
  selectByIndex: ((index: number) => void) | null;
  // Registered by SearchBar (G3): replace the search text + run the query
  // pipeline immediately. InfoCard pivots call it. null until SearchBar mounts.
  injectSearchQuery: ((text: string) => void) | null;
  triggerFlyTo: ((index: number) => void) | null;
  triggerJoyride: ((index: number) => void) | null;
  triggerResetCamera: (() => void) | null;
  // P2 — run a validated analytic program on the engine; returns the executor
  // outcome (or null if the layer isn't ready). Side-effect-free re: the globe;
  // the caller (useAnalyticAsk) applies the allow-set + answer slice.
  triggerRunAnalytic: ((program: AnalyticProgram) => ExecuteOutcome | null) | null;
  triggerFlyToDso: ((dsoId: string) => void) | null;
  triggerJoyrideDso: ((dsoId: string) => void) | null;
  triggerSimTimeJump: (() => void) | null;
  /** Engine hook for a light scrub preview (day-aware throttled snap), set by the Engine. */
  triggerScrubPreview: (() => void) | null;
  /** Engine hook to animate the view-clock back to now, set by the Engine. */
  triggerReturnToPresent: (() => void) | null;
  setTriggerFlyTo: (fn: (index: number) => void) => void;
  setTriggerJoyride: (fn: (index: number) => void) => void;
  setTriggerResetCamera: (fn: () => void) => void;
  setTriggerRunAnalytic: (fn: (program: AnalyticProgram) => ExecuteOutcome | null) => void;
  setSelectByIndex: (fn: (index: number) => void) => void;
  setInjectSearchQuery: (fn: ((text: string) => void) | null) => void;
  setTriggerSimTimeJump: (fn: () => void) => void;
  setTriggerScrubPreview: (fn: () => void) => void;
  setTriggerReturnToPresent: (fn: () => void) => void;
  setTriggerFlyToDso: (fn: (dsoId: string) => void) => void;
  setTriggerJoyrideDso: (fn: (dsoId: string) => void) => void;
}

export interface InteractionSlice {
  cameraMode: CameraMode;
  trackingStyle: TrackingStyle;
  selectedIndex: number | null;
  selectedSatellite: EnrichedTLEObject | null;
  selectedAltitude: number | null;
  showOrbitTrail: boolean;
  selectedDso: DsoObject | null;
  hoveredName: string | null;
  hoverScreenX: number;
  hoverScreenY: number;
  clusterItems: { index: number; data: EnrichedTLEObject; altitude: number }[];
  clusterScreenX: number;
  clusterScreenY: number;
  setCameraMode: (mode: CameraMode) => void;
  setTrackingStyle: (style: TrackingStyle) => void;
  setSelectedSatellite: (
    index: number | null,
    data: EnrichedTLEObject | null,
    altitude?: number | null,
  ) => void;
  setSelectedDso: (dso: DsoObject | null) => void;
  setShowOrbitTrail: (show: boolean) => void;
  setHover: (name: string | null, screenX?: number, screenY?: number) => void;
  setCluster: (items: { index: number; data: EnrichedTLEObject; altitude: number }[], screenX: number, screenY: number) => void;
  clearCluster: () => void;
}

export interface ObserverSlice {
  observerLocation: GeodeticObserver | null;
  visibilityMode: VisibilityMode;
  /** Dome-mode gaze heading (radians, from North toward East); drives the HUD compass. */
  observerHeadingRad: number;
  visualList: VisualListState;
  setObserverLocation: (loc: GeodeticObserver | null) => void;
  setVisibilityMode: (mode: VisibilityMode) => void;
  setObserverHeadingRad: (rad: number) => void;
  setVisualListState: (state: VisualListState) => void;
}

export interface FilterSlice {
  regimeFilters: Record<OrbitalRegime, boolean>;
  visibleRegimeCounts: Record<OrbitalRegime, number>;
  visibleFacetCounts: FacetCounts;
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
  toggleRegimeFilter: (regime: OrbitalRegime) => void;
  setVisibleCounts: (regCounts: Record<OrbitalRegime, number>) => void;
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
  setVisibleFacetCounts: (counts: FacetCounts) => void;
}

export interface AnalyticSlice {
  analyticFilter: AnalyticFilter; // P1 — set only by analytic program runs
  analyticAnswer: AnalyticAnswer | null; // P2 — current NL→IR answer (AnswerCard)
  /** Apply (or clear, with null) an analytic program's noradId allow-set. Semantic
   *  equality is checked inline so an identical re-run never triggers a recompute. */
  setAnalyticFilter: (ids: Set<number> | null) => void;
  setAnalyticAnswer: (answer: AnalyticAnswer | null) => void;
  /** The single exit door: clears the answer card AND the globe allow-set. */
  clearAnalyticAnswer: () => void;
}

export interface TimeSlice {
  // Simulation clock (UI mirrors — simClock is source of truth)
  simRate: number;
  simTimeMs: number;
  /** First-class liveness: tracking now (live) vs scrubbed/playing away (review). */
  viewMode: ViewMode;
  /** Wall-clock now (ms) — the always-advancing live edge; pushed ~4 Hz by the loop. */
  wallClockMs: number;
  /** Whether the modal time-scrubber (Star Walk wheel) is open (dims the rest of the HUD). */
  scrubberMode: boolean;
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
}

export interface HistorySlice {
  // Historical time-scrub (review plane) — UI mirrors of Engine-held state.
  historyCoverage: HistoryCoverage | null;
  historyDay: string | null;     // null = live; else the loaded UTC day 'YYYY-MM-DD'
  historyLoading: boolean;
  /** True while reviewing a date with NO satellite catalog (planetarium: sky only). */
  planetarium: boolean;
  setHistoryCoverage: (coverage: HistoryCoverage | null) => void;
  setHistoryDay: (day: string | null) => void;
  setHistoryLoading: (loading: boolean) => void;
  setPlanetarium: (on: boolean) => void;
}

export interface DsoSlice {
  dsoObjects: DsoObject[];
  dsoEphemerisById: Record<string, DsoSnapshot>;
  dsoLabelPositions: DsoLabelPosition[];
  setDsoObjects: (objects: DsoObject[]) => void;
  setDsoEphemeris: (dsoId: string, snapshot: DsoSnapshot) => void;
  setDsoLabelPositions: (positions: DsoLabelPosition[]) => void;
}

export type AppState = BootSlice &
  CatalogSlice &
  CommandSlice &
  InteractionSlice &
  ObserverSlice &
  FilterSlice &
  AnalyticSlice &
  TimeSlice &
  HistorySlice &
  DsoSlice;

export type Slice<T> = StateCreator<AppState, [], [], T>;
