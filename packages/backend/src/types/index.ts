import type { OMMJsonObject } from 'satellite.js';
import type { Sector, Purpose, OrbitalStatus } from '../enrichment/types.js';

/** Re-export so both packages share one source of truth for the OMM shape. */
export type { OMMJsonObject };

// ============================================================
// Shared type definitions for the backend
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

export type ObjectType = 'satellite' | 'rocket_body' | 'debris' | 'unknown';

export type ObjectCategory =
  | 'active_satellite'
  | 'inactive_satellite'
  | 'rocket_body'
  | 'debris'
  | 'unknown'
  | 'deep_space';

export type OrbitalRegime = 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'OTHER';

// Fully enriched object — this is what gets cached and served to clients
export interface EnrichedTLEObject {
  noradId: number;
  name: string;
  omm: OMMJsonObject;            // OMM mean elements (for SGP4 propagation on client)
  objectType: ObjectType;
  category: ObjectCategory;
  regime: OrbitalRegime;
  countryCode: string;
  launchDate: string | null;
  period: number;                // minutes
  apogee: number;                // km
  perigee: number;               // km
  inclination: number;           // degrees
  rcsSize: string | null;
  epoch: string;                 // ISO timestamp of the TLE epoch
  // ── Inline metadata facets (joined in the cron from the enrichment store) ──
  // status = orbital status from the McDowell satcat.csv (in_orbit/decayed/...);
  // sectors/purpose come from the UCS join ([] / 'other' when unmatched).
  sectors: Sector[];
  purpose: Purpose;
  status: OrbitalStatus;
  // Program membership (programs.ts registry slug, e.g. 'starlink'). Omitted
  // when the object matches no program, keeping the hot payload lean.
  program?: string;
  // GCAT launch tag ("2019-074") — the launch/vehicle/site query facets' join
  // key (G3). Omitted when the enrichment record has none.
  launchTag?: string;
  // Primary owner org code ("SPXS") — the operator query facet (G3).
  owner?: string;
}

// Written to data/version.json
export interface VersionInfo {
  version: string;               // ISO timestamp of when this cache was built
  count: number;
  byteSize: number;              // byte size of tle-cache.json
}

// HTTP response shape for GET /api/tle/all
export interface TLEApiResponse {
  version: string;
  count: number;
  data: EnrichedTLEObject[];
}
