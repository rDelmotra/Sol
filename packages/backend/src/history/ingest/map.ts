import type { EnrichedTLEObject, ObjectCategory, ObjectType } from '@orbitwatch/contracts';
import type { HistoryDimRow, HistoryFactRow } from '../types.js';

// ============================================================
// Pure mapping: EnrichedTLEObject → { dim, fact } upsert rows.
//
// No DB, no I/O — unit-tested directly (tests/history/map.test.ts). The cron has
// already built `omm` (via buildOmm) and category/regime (via classifyObject),
// so ingest re-normalizes NOTHING; it just reshapes for the two tables.
//
//   utc_day  = the UTC calendar day of the elset's epoch (the daily bucket).
//   epoch    = the elset's true instant (kept so ON CONFLICT keeps the latest
//              elset within a day and so reconstruction is exact).
// ============================================================

/** OMM numeric fields are typed `string | number`; coerce to a finite number. */
function num(value: string | number | undefined | null, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Accept only a well-formed 'YYYY-MM-DD' prefix; anything else → null. */
function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}

/**
 * Re-derive the coarse ObjectType from the (time-varying) category, mirroring the
 * cron's mapping. Stored implicitly via category, so serving stays as-of-correct
 * without an extra column.
 */
export function objectTypeFromCategory(category: ObjectCategory): ObjectType {
  if (category === 'active_satellite' || category === 'inactive_satellite') return 'satellite';
  if (category === 'rocket_body') return 'rocket_body';
  if (category === 'debris') return 'debris';
  return 'unknown';
}

export interface MappedRow {
  dim: HistoryDimRow;
  fact: HistoryFactRow;
}

/**
 * Map one enriched object to its dim + fact rows. Returns null when the epoch is
 * unparseable (the only field we can't recover from) so the caller skips it.
 */
export function mapEnriched(obj: EnrichedTLEObject): MappedRow | null {
  const epochDate = new Date(obj.epoch);
  if (Number.isNaN(epochDate.getTime())) return null;

  const utcDay = epochDate.toISOString().slice(0, 10); // 'YYYY-MM-DD' (UTC)
  const epochIso = epochDate.toISOString();
  const omm = obj.omm;

  const dim: HistoryDimRow = {
    norad_id: obj.noradId,
    object_name: obj.name,
    object_id: typeof omm.OBJECT_ID === 'string' ? omm.OBJECT_ID : '',
    country_code: obj.countryCode ?? '',
    launch_date: dateOnly(obj.launchDate),
    rcs_size: obj.rcsSize ?? null,
    utc_day: utcDay,
  };

  const fact: HistoryFactRow = {
    norad_id: obj.noradId,
    utc_day: utcDay,
    epoch: epochIso,
    mean_motion: num(omm.MEAN_MOTION),
    eccentricity: num(omm.ECCENTRICITY),
    inclination: num(omm.INCLINATION),
    ra_of_asc_node: num(omm.RA_OF_ASC_NODE),
    arg_of_pericenter: num(omm.ARG_OF_PERICENTER),
    mean_anomaly: num(omm.MEAN_ANOMALY),
    bstar: num(omm.BSTAR),
    mean_motion_dot: num(omm.MEAN_MOTION_DOT),
    mean_motion_ddot: num(omm.MEAN_MOTION_DDOT),
    ephemeris_type: num(omm.EPHEMERIS_TYPE, 0),
    element_set_no: num(omm.ELEMENT_SET_NO, 0),
    rev_at_epoch: num(omm.REV_AT_EPOCH, 0),
    classification_type: omm.CLASSIFICATION_TYPE === 'C' ? 'C' : 'U',
    period: obj.period ?? 0,
    apogee_km: obj.apogee ?? 0,
    perigee_km: obj.perigee ?? 0,
    category: obj.category,
    regime: obj.regime,
    source: 'unknown', // overwritten by the sink with the fetch source
  };

  return { dim, fact };
}
