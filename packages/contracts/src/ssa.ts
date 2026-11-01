// ============================================================
// @orbitwatch/contracts — ssa.ts
//
// Wire shapes for /api/ssa/*: the nightly encounter screen (close approaches
// between catalogued objects) and the events derived from it. Encounters are
// presented neutrally as plain numbers (miss distance, relative speed, Pc);
// there is deliberately no tier or severity field.
// ============================================================

/** One screening run. All times are ISO-8601 UTC. */
export interface SsaRunInfo {
  id: number;
  batchTime: string;
  elementCutoff: string;
  objects: number;
  encounters: number;
  durationS: number;
  codeVersion: string;
}

export interface EncounterObject {
  noradId: number;
  name: string | null;
  objectType: string | null;
  /**
   * Time (ISO) of this object's latest observed orbit change (an `elements.jump` event: the new element set differs from the
   * previous one propagated forward by more than ~16 km and 1 km in semi-major axis) in the 7 days before the screening run;
   * null when none was seen. This is an observation. It is not `EncounterSummary.manoeuvrable`, which is a capability
   * guess from the object's family (Starlink class and the like) and says nothing about what the object did recently.
   */
  lastManoeuvreAt: string | null;
}

export interface EncounterSummary {
  id: number;
  a: EncounterObject;
  b: EncounterObject;
  /** Time of closest approach, ISO. */
  tca: string;
  missKm: number;
  relSpeedKms: number;
  /** Radial / in-track / cross-track separation of b relative to a at TCA, km. */
  ricKm: [number, number, number];
  volume: string;
  /** Probability of collision (balanced covariance model). */
  pc: number | null;
  /** Upper-bound Pc carried alongside for audit. */
  pcMax: number | null;
  hardBodyRadiusKm: number | null;
  /**
   * Family-based capability: true when a constellation that manoeuvres routinely (Starlink class and the like) is involved, so the
   * forecast churns most. Static per object family; for what an object actually did see `EncounterObject.lastManoeuvreAt`.
   */
  manoeuvrable: boolean;
  label: string | null;
  /** Batch time of the first run that reported this encounter, ISO. */
  firstSeen: string | null;
  updates: number;
}

export interface EncounterUpdate {
  runId: number;
  batchTime: string;
  tca: string;
  missKm: number;
  pc: number | null;
  pcMax: number | null;
  ricKm: [number, number, number] | null;
}

export interface EncounterDetail extends EncounterSummary {
  history: EncounterUpdate[];
}

export interface SsaEvent {
  id: number;
  /** UTC day, 'YYYY-MM-DD'. */
  day: string;
  kind: string;
  subjects: number[];
  tStart: string | null;
  tEnd: string | null;
  payload: unknown;
}

export interface ObjectEncounters {
  noradId: number;
  run: SsaRunInfo | null;
  encounters: EncounterSummary[];
  events: SsaEvent[];
}

// ── Response envelopes ──────────────────────────────────────────────────────
export interface SsaRunResponse extends SsaRunInfo {}

export interface SsaConjunctionsResponse {
  run: SsaRunInfo;
  count: number;
  encounters: EncounterSummary[];
}

export type SsaEncounterResponse = EncounterDetail;
export type SsaObjectResponse = ObjectEncounters;

export interface SsaEventsResponse {
  count: number;
  events: SsaEvent[];
}

export interface SsaErrorResponse {
  error: string;
}

// ── Ground passes over time (/api/ssa/passes, /api/ssa/regions) ─────────────
/**
 * Named regions the pass queries know. Only India is a careful outline; the others are rough polygons (`approximate: true`).
 * The backend asserts that its region table has exactly these ids (tests/ssa/regions-contract.test.ts).
 */
export const SSA_PASS_REGION_IDS = ['india', 'usa_conus', 'europe', 'china', 'brazil', 'australia', 'japan'] as const;
export type SsaPassRegionId = (typeof SSA_PASS_REGION_IDS)[number];
/** Longest window a pass query accepts, in days (a longer one is a 400). */
export const SSA_PASS_MAX_WINDOW_DAYS = 90;
/** A circle region: radius limits in km. */
export const SSA_PASS_CIRCLE_MIN_KM = 5;
export const SSA_PASS_CIRCLE_MAX_KM = 3000;

export interface SsaRegionInfo {
  /** 'india' | ... for a named region; 'circle:<lat>,<lon>,<km>' for a circle */
  id: string;
  name: string;
  kind: 'polygon' | 'circle';
  /** true for the rough outlines (everything but India); circles are exact */
  approximate: boolean;
  latDeg?: number;
  lonDeg?: number;
  radiusKm?: number;
}

export interface SsaRegionsResponse {
  regions: SsaRegionInfo[];
  circle: { minRadiusKm: number; maxRadiusKm: number };
  maxWindowDays: number;
}

export interface SsaPassInterval {
  /** first and last sample inside the region, ISO-8601 UTC (1 s resolution) */
  start: string;
  end: string;
}

export interface SsaPassObject {
  noradId: number;
  name: string | null;
  passes: SsaPassInterval[];
  /** number of passes listed for this object */
  count: number;
}

export interface SsaPassesResponse {
  region: SsaRegionInfo;
  from: string;
  to: string;
  /** true when `to` was in the future and was cut at the current time */
  clippedToNow: boolean;
  /** objects with at least one pass in the window (all of them) */
  totalObjects: number;
  /** the objects listed below, lowest NORAD id first, at most `limit` (their passes are complete) */
  objects: SsaPassObject[];
  /** UTC days of the window without coverage files: not searched (listed, never silently skipped) */
  missingDays: string[];
  /** days without coverage that were computed on the fly by brute force (`fill=1`, at most 2 days) */
  filledDays: string[];
  /** what "passed over" and the answer's accuracy mean */
  guarantee: string;
  definition: string;
  timing: { wallS: number; days: number; candidateObjectDays: number; refinedObjectDays: number };
}
