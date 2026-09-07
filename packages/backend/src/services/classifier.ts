import {
  ClassifiableObject,
  ObjectType,
  ObjectCategory,
  OrbitalRegime,
} from '../types/index.js';

// ============================================================
// Orbital regime boundaries
// Based on orbital PERIOD (minutes), not altitude, because period
// is directly available from the GP element set without any
// trigonometry.  The altitude–period relationship follows Kepler's
// third law: T = 2π × sqrt(a³/μ), where μ = 398 600.4418 km³/s².
//
// LEO:  period < 128 min   → roughly altitude < 2 000 km
// MEO:  128 ≤ period < 1380 min → 2 000 – 35 000 km
// GEO:  1380 ≤ period ≤ 1500 min AND eccentricity < 0.1
//        → the geostationary belt (~35 786 km)
//        The period window (±60 min around the 1436 min sidereal day)
//        captures both true GEO and slightly inclined GSO satellites.
// HEO:  eccentricity ≥ 0.25 regardless of period
//        → Molniya (e~0.74, T~11.97h), Tundra, GTO, highly elliptical
//        Note: HEO is checked BEFORE GEO so a Molniya-like object with
//        GEO-ish period but high eccentricity is correctly classified.
// OTHER: everything that doesn't fit the above (e.g., sub-orbital test
//        objects logged briefly, anomalous catalog entries)
// ============================================================

const LEO_MAX_PERIOD = 128;           // minutes
const MEO_MAX_PERIOD = 1380;          // minutes
const GEO_MIN_PERIOD = 1380;          // minutes
const GEO_MAX_PERIOD = 1500;          // minutes
const GEO_MAX_ECCENTRICITY = 0.1;     // GEO must be near-circular
const HEO_MIN_ECCENTRICITY = 0.25;    // highly elliptical threshold

function classifyRegime(period: number, eccentricity: number): OrbitalRegime {
  // HEO is checked first — a Molniya orbit has a ~12h period that would
  // otherwise land in MEO, but its eccentricity (~0.74) betrays it.
  if (eccentricity >= HEO_MIN_ECCENTRICITY) return 'HEO';

  if (period < LEO_MAX_PERIOD) return 'LEO';

  if (period >= GEO_MIN_PERIOD && period <= GEO_MAX_PERIOD &&
      eccentricity < GEO_MAX_ECCENTRICITY) return 'GEO';

  if (period >= LEO_MAX_PERIOD && period < MEO_MAX_PERIOD) return 'MEO';

  return 'OTHER';
}

// ============================================================
// Object type mapping
//
// Both Space-Track and CelesTrak use the same OBJECT_TYPE strings.
// "ROCKET BODY" has a space. "TBA" (Space-Track only) → unknown.
// ============================================================
export function classifyObjectType(celestrakType: string): ObjectType {
  switch (celestrakType?.toUpperCase()) {
    case 'PAYLOAD':      return 'satellite';
    case 'ROCKET BODY':  return 'rocket_body';
    case 'DEBRIS':       return 'debris';
    default:             return 'unknown';
  }
}

// ============================================================
// Operational status → combined category
//
// OPS_STATUS_CODE from Space-Track SATCAT:
//   "+"  = operational / active
//   "P"  = partially operational
//   "-"  = non-operational / inactive
//   "B"  = backup / standby
//   "S"  = spare
//   "X"  = extended mission
//   "D"  = decayed (should not appear here; we filter at fetch time)
//   ""   = unknown
//
// For the frontend renderer we collapse to:
//   active_satellite    — operational payload
//   inactive_satellite  — non-operational payload
//   rocket_body         — any spent rocket stage (always "inactive" by nature)
//   debris              — any tracked fragment (always "inactive" by nature)
//   unknown             — anything we can't determine
// ============================================================
const ACTIVE_STATUS_CODES = new Set(['+', 'P', 'B', 'S', 'X']);

function classifyCategory(
  objectType: ObjectType,
  opsStatusCode: string | undefined,
): ObjectCategory {
  if (objectType === 'rocket_body') return 'rocket_body';
  if (objectType === 'debris')      return 'debris';

  if (objectType === 'satellite') {
    if (!opsStatusCode) return 'unknown';
    return ACTIVE_STATUS_CODES.has(opsStatusCode)
      ? 'active_satellite'
      : 'inactive_satellite';
  }

  return 'unknown';
}

/**
 * Classify an orbital object into its regime and category.
 *
 * @param obj - Source-agnostic normalized object. The caller (tle-updater) is
 *              responsible for parsing string fields to numbers before passing
 *              them here so this function stays source-independent.
 *
 * opsStatusCode is only available when Space-Track SATCAT was fetched.
 * When absent (CelesTrak fallback path), payloads classify as "unknown".
 */
export function classifyObject(
  obj: ClassifiableObject,
): { category: ObjectCategory; regime: OrbitalRegime } {
  const regime = classifyRegime(obj.period, obj.eccentricity);
  const objectType = classifyObjectType(obj.objectType);
  const category = classifyCategory(objectType, obj.opsStatusCode);
  return { category, regime };
}
