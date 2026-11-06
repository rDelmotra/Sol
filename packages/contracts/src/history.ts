// ============================================================
// @orbitwatch/contracts — history.ts
//
// Wire shapes for /api/history/{range,catalog,timeline}: the day-by-day history of the catalog (1959 on) that the backend serves from
// the history backfill (SSA_HISTORY_DIR) and ssa_event. The older /api/history/coverage and /api/history/at have their own shapes.
// All days are UTC calendar days, 'YYYY-MM-DD'.
// ============================================================

/** GET /api/history/range */
export interface HistoryRange {
  /** first / last day with built history (coverage days; element-set days when there is no coverage); null when empty */
  firstDay: string | null;
  lastDay: string | null;
  /** number of days with built history between them (gaps in the data make it smaller than the span) */
  days: number;
  /** first / last day with a change-events file */
  eventsFirstDay: string | null;
  eventsLastDay: string | null;
  /** star-map coverage files exist for the days (the passes API can answer for them) */
  hasCoverage: boolean;
}

/** One element set, as in the backfill's element-set files (OMM names; angles in degrees, MEAN_MOTION in rev/day). */
export interface HistoryOmm {
  OBJECT_NAME: string;
  OBJECT_ID: string | null;
  /** 'YYYY-MM-DDTHH:MM:SS.mmmZ' */
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  EPHEMERIS_TYPE: number;
  CLASSIFICATION_TYPE: string;
  NORAD_CAT_ID: number;
  ELEMENT_SET_NO: number;
  REV_AT_EPOCH: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
  /** sets from McDowell's archive (1957-1972) carry extra XTLE_* / HIST_SRC provenance fields */
  [extra: string]: string | number | null | undefined;
}

export interface HistoryCatalogObject {
  noradId: number;
  name: string;
  /** satellite | rocket_body | debris | unknown */
  objectType: string;
  /** 'YYYY-NNNA' */
  intlDesignator: string | null;
  launchDate: string | null;
  /** the object's eventual decay date (known later, not at the time); the catalog of a day never lists an object after its decay */
  decayDate: string | null;
  /** propagation model of `omm`: SGP4, or the original SGP for pre-1980 sets made for it (src/ssa/history/propagator-policy.ts) */
  propagator: 'sgp4' | 'sgp';
  omm: HistoryOmm;
}

/** GET /api/history/catalog?day= — the catalog as of the END of that day: per object the latest set before it, within the era's staleness window. */
export interface HistoryCatalog {
  day: string;
  /** typical position error of the era's sets with the era's model (chain check median / 95th percentile, km); null where not measured (1980 on: SGP4 production quality) */
  accuracy: { medianKm: number; p95Km: number } | null;
  objects: HistoryCatalogObject[];
}

/** GET /api/history/timeline — event counts per bucket (empty buckets are left out). */
export interface HistoryTimelineBucket {
  /** ISO start of the bucket (UTC day / month / year) */
  t: string;
  /** event kind -> number of events (object.appeared, object.disappeared, elements.jump, close.formation, object.breakup, ...) */
  counts: Record<string, number>;
}
