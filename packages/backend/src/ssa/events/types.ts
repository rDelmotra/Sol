// ============================================================
// Types of the change-detection layer (src/ssa/events/). "Changes" are derived events computed once per UTC day from two
// catalog snapshots (the day before and the day itself): a new object, an object no longer tracked, an orbit change, a formation.
// ============================================================

/** One object of a day's catalog: the latest element set before the day's end, plus the catalog fields the payloads quote. */
export interface ChangeObject {
  noradId: number;
  name: string;
  /** LEO | MEO | GEO | HEO | OTHER */
  regime: string;
  /** altitude above the surface, km (from the elements) */
  perigee?: number;
  apogee?: number;
  /** 'YYYY-MM-DD' (object_dim) */
  launchDate?: string | null;
  /** OMM mean elements as satellite.js json2satrec reads them */
  omm: Record<string, unknown>;
  /** propagation model of `omm`; absent = SGP4 (production never sets it; the history backfill sets 'sgp' for pre-1980 sets without B*) */
  propagator?: 'sgp4' | 'sgp';
}

export const CHANGE_KINDS = ['object.appeared', 'object.disappeared', 'elements.jump', 'close.formation'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** A row of ssa_event (before insertion). Times are UTC ms. */
export interface EventRow {
  kind: ChangeKind;
  subjects: number[];
  tStart: number;
  tEnd: number;
  payload: Record<string, unknown>;
}

/** Orbit-change thresholds (scripts/starmap/jump-study.ts, STARMAP.md "Element jumps"). */
export const JUMP_DPOS_KM = 16.3;
export const JUMP_DA_KM = 1.0;
/** Formation: two objects within FORM_KM of each other for more than FORM_FRAC of the day. */
export const FORM_KM = 50;
export const FORM_FRAC = 0.5;
/** An element set older than this (days before the day's end) is no longer part of the day's catalog. */
export const CATALOG_WINDOW_DAYS = 30;
/** Window (days) in which an orbit change still flags an encounter as "recently manoeuvred". */
export const RECENT_JUMP_DAYS = 7;
export const DAY_MS = 86_400_000;
