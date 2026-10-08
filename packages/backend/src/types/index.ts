// ============================================================
// Shared type definitions for the backend
//
// Wire/domain types shared with the frontend (EnrichedTLEObject, ObjectType,
// ObjectCategory, OrbitalRegime, OMMJsonObject) live in @orbitwatch/contracts
// as of C2a — import them from there. What's left here is backend-local:
// raw provider shapes, the classifier's input contract, and the version
// cache metadata.
// ============================================================

// ── Space-Track GP element ────────────────────────────────────────────────────
// Space-Track's JSON API returns ALL numeric values as strings.
// e.g. NORAD_CAT_ID is "25544", PERIOD is "92.87", ECCENTRICITY is "0.0001234".
// Parse them explicitly before doing any math.
export interface SpaceTrackGPElement {
  NORAD_CAT_ID: string;          // "25544"
  OBJECT_NAME: string;           // "ISS (ZARYA)"
  OBJECT_ID: string;             // "1998-067A" (international designator)
  OBJECT_TYPE: string;           // "PAYLOAD" | "ROCKET BODY" | "DEBRIS" | "UNKNOWN" | "TBA"
  CLASSIFICATION_TYPE: string;   // "U"
  TLE_LINE0: string;             // "0 ISS (ZARYA)"
  TLE_LINE1: string;             // "1 25544U 98067A ..."
  TLE_LINE2: string;             // "2 25544  51.6412 ..."
  EPOCH: string;                 // "2024-03-15T12:00:00.000000"
  MEAN_MOTION: string;           // revs/day
  ECCENTRICITY: string;          // dimensionless
  INCLINATION: string;           // degrees
  RA_OF_ASC_NODE: string;        // degrees
  ARG_OF_PERICENTER: string;     // degrees
  MEAN_ANOMALY: string;          // degrees
  EPHEMERIS_TYPE: string;        // "0"
  ELEMENT_SET_NO: string;
  REV_AT_EPOCH: string;
  BSTAR: string;
  MEAN_MOTION_DOT: string;
  MEAN_MOTION_DDOT: string;
  SEMIMAJOR_AXIS: string;        // km
  PERIOD: string;                // minutes
  APOAPSIS: string;              // km above surface (apogee)
  PERIAPSIS: string;             // km above surface (perigee)
  RCS_SIZE: string;              // "LARGE" | "MEDIUM" | "SMALL" | "" (empty = unknown)
  COUNTRY_CODE: string;
  LAUNCH_DATE: string;           // "1998-11-20" | "" (empty = unknown)
  SITE: string;
  DECAY_DATE: string;            // "" for active objects (NOT null — Space-Track uses empty string)
  FILE: string;
  GP_ID: string;
}

// ── CelesTrak GP element ──────────────────────────────────────────────────────
// CelesTrak returns proper JSON types (numbers are numbers, not strings).
// Used as fallback when Space-Track is unavailable.
export interface CelesTrakGPElement {
  OBJECT_NAME: string;
  OBJECT_ID: string;
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
  TLE_LINE0: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
  OBJECT_TYPE: string;           // "PAYLOAD" | "ROCKET BODY" | "DEBRIS" | "UNKNOWN"
  RCS_SIZE: string | null;
  COUNTRY_CODE: string;
  LAUNCH_DATE: string;
  SITE: string;
  DECAY_DATE: string | null;     // null = still in orbit (CelesTrak uses null, not "")
  PERIOD: number;                // minutes (already a number)
  APOAPSIS: number;              // km
  PERIAPSIS: number;             // km
}

// ── Classifier input ──────────────────────────────────────────────────────────
// Normalised shape that classifyObject() accepts, independent of data source.
// The tle-updater maps both SpaceTrackGPElement and CelesTrakGPElement to this
// before calling the classifier.
export interface ClassifiableObject {
  period: number;       // orbital period in minutes (already parsed to number)
  eccentricity: number;
  objectType: string;   // raw OBJECT_TYPE string from the API ("PAYLOAD", etc.)
  opsStatusCode?: string; // only available when SATCAT was fetched (Space-Track primary)
}

// Written to data/version.json
export interface VersionInfo {
  version: string;               // ISO timestamp of when this cache was built
  count: number;
  byteSize: number;              // byte size of tle-cache.json
}

export interface SwpcDailyIndex {
  /** UTC calendar day, 'YYYY-MM-DD'. */
  date: string;
  /** NOAA Estimated Planetary A-index (daily). */
  apIndex: number | null;
  /** NOAA Estimated Planetary Kp, daily mean of the 8 three-hourly values. */
  kpIndex: number | null;
  /** Observed 10.7cm solar radio flux, sfu. */
  f107: number | null;
}

/** One place record extracted from the source GeoJSON — only the fields the
 *  resolver needs, not the full upstream properties bag. */
export interface GazetteerSourceRecord {
  /** Canonical display name (feature.properties.name, falling back to nameascii). */
  name: string;
  nameAscii: string | null;
  nameAlt: string | null;
  lsName: string | null;
  megaName: string | null;
  namePar: string | null;
  adm0Name: string | null;
  adm1Name: string | null;
  popMax: number | null;
  /** feature.geometry.coordinates[0] — GeoJSON [lon, lat] order. Do not swap. */
  lonDeg: number;
  /** feature.geometry.coordinates[1]. */
  latDeg: number;
  /** Stable per-record id: `ne:<ne_id>` when the source provides one, else a
   *  positional fallback (`ne:<index>:<name>`) so dedup by id still works. */
  sourceId: string;
}
