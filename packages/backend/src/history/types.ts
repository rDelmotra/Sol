import type { ObjectCategory, OrbitalRegime } from '@orbitwatch/contracts';

// ============================================================
// History namespace — shared row/coverage types
//
// Two physical tables back the daily-downsampled serving view:
//   object_dim  — static-per-object metadata (~60k rows)
//   omm_daily   — one row per (norad_id, UTC day): that day's latest elset
//
// The *upsert* shapes (HistoryDimRow / HistoryFactRow) are produced by
// ingest/map.ts from an EnrichedTLEObject; the *read* shape (HistoryServingRow)
// is what the as-of SELECT returns and serving/reconstruct.ts maps back into an
// EnrichedTLEObject (identical to what /api/tle/all serves).
// ============================================================

/** Upsert payload for object_dim. `utcDay` seeds both first_seen and last_seen. */
export interface HistoryDimRow {
  norad_id: number;
  object_name: string;
  object_id: string;
  country_code: string;
  launch_date: string | null; // 'YYYY-MM-DD' or null
  rcs_size: string | null;
  utc_day: string;            // 'YYYY-MM-DD' — first_seen/last_seen on insert
}

/** Upsert payload for omm_daily (the daily fact row). */
export interface HistoryFactRow {
  norad_id: number;
  utc_day: string;            // 'YYYY-MM-DD' (partition + dedup key)
  epoch: string;              // ISO-8601 timestamptz (the elset's true epoch)
  // OMM mean elements (json2satrec inputs) ───────────────────
  mean_motion: number;
  eccentricity: number;
  inclination: number;        // degrees — doubles as the top-level inclination
  ra_of_asc_node: number;
  arg_of_pericenter: number;
  mean_anomaly: number;
  bstar: number;
  mean_motion_dot: number;
  mean_motion_ddot: number;
  ephemeris_type: number;
  element_set_no: number;
  rev_at_epoch: number;
  classification_type: string; // 'U' | 'C'
  // Enrichment (already computed by the cron via classifyObject) ──
  period: number;             // minutes
  apogee_km: number;
  perigee_km: number;
  category: string;           // ObjectCategory
  regime: string;             // OrbitalRegime
  source: string;             // 'space-track' | 'celestrak' | ...
}

/** Raw row returned by the as-of SELECT (omm_daily JOIN object_dim). */
export interface HistoryServingRow {
  norad_id: number;
  object_name: string;
  object_id: string;
  country_code: string;
  launch_date: string | null; // via to_char(...)
  rcs_size: string | null;
  epoch: Date;                // timestamptz → JS Date
  mean_motion: number;
  eccentricity: number;
  inclination: number;
  ra_of_asc_node: number;
  arg_of_pericenter: number;
  mean_anomaly: number;
  bstar: number;
  mean_motion_dot: number;
  mean_motion_ddot: number;
  ephemeris_type: number;
  element_set_no: number;
  rev_at_epoch: number;
  classification_type: string;
  period: number;
  apogee_km: number;
  perigee_km: number;
  category: ObjectCategory;
  regime: OrbitalRegime;
  ingested_at: Date;
}

/** Time span the history DB currently covers — drives the frontend scrubber. */
export interface HistoryCoverage {
  from: string | null;        // earliest utc_day 'YYYY-MM-DD' (null if empty)
  to: string | null;          // latest utc_day 'YYYY-MM-DD'
  objectCount: number;        // distinct objects in object_dim
  lastIngestAt: string | null; // ISO of the most recent ingest
}
