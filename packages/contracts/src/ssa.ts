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
  /** True when a manoeuvring object (e.g. Starlink class) is involved; its forecast churns most. */
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
