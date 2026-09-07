import type { EnrichedTLEObject, OMMJsonObject } from '../../types/index.js';
import type { HistoryServingRow } from '../types.js';
import { objectTypeFromCategory } from '../ingest/map.js';

// ============================================================
// Reconstruct an EnrichedTLEObject from a serving row.
//
// The output is byte-for-byte the same shape /api/tle/all serves, so the
// frontend re-seeds the SGP4 worker with a history snapshot exactly as it does
// the live catalog. The OMM is rebuilt from typed columns + the dimension
// (OBJECT_NAME/OBJECT_ID/NORAD_CAT_ID), with no TLE lines (matching buildOmm).
// ============================================================

export function reconstructEnriched(row: HistoryServingRow): EnrichedTLEObject {
  const epochIso = row.epoch.toISOString();

  const omm: OMMJsonObject = {
    OBJECT_NAME: row.object_name,
    OBJECT_ID: row.object_id,
    EPOCH: epochIso,
    MEAN_MOTION: row.mean_motion,
    ECCENTRICITY: row.eccentricity,
    INCLINATION: row.inclination,
    RA_OF_ASC_NODE: row.ra_of_asc_node,
    ARG_OF_PERICENTER: row.arg_of_pericenter,
    MEAN_ANOMALY: row.mean_anomaly,
    // OMMJsonObject types EPHEMERIS_TYPE as the literal 0 (SGP4 is always 0).
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: row.classification_type === 'C' ? 'C' : 'U',
    NORAD_CAT_ID: row.norad_id,
    ELEMENT_SET_NO: row.element_set_no,
    REV_AT_EPOCH: row.rev_at_epoch,
    BSTAR: row.bstar,
    MEAN_MOTION_DOT: row.mean_motion_dot,
    MEAN_MOTION_DDOT: row.mean_motion_ddot,
  };

  return {
    noradId: row.norad_id,
    name: row.object_name,
    omm,
    objectType: objectTypeFromCategory(row.category),
    category: row.category,
    regime: row.regime,
    countryCode: row.country_code,
    launchDate: row.launch_date,
    period: row.period,
    apogee: row.apogee_km,
    perigee: row.perigee_km,
    inclination: row.inclination,
    rcsSize: row.rcs_size,
    epoch: epochIso,
    // Historical rows carry no enrichment join. The as-of query only returns
    // objects tracked on that day, so they were in orbit then; default the
    // UCS-only facets. (Phase-2 history could persist these in the dimension table.)
    status: 'in_orbit',
    sectors: [],
    purpose: 'other',
  };
}
