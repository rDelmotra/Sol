// ============================================================
// Metadata enrichment — normalized type model
//
// One join record per cataloged object, keyed by NORAD ID. Aggregates the
// richest available metadata across three sources (live Space-Track, the
// McDowell General Catalog snapshot, and the UCS Satellite Database snapshot),
// each normalized to the source's own terminology.
//
// See my_plans/metadata_enrichment.md for the design rationale and per-facet
// source authority. NOT YET WIRED — defined ahead of the live join.
// ============================================================

// ── Sector (from UCS "Users") ─────────────────────────────────────────────────
// UCS encodes one or more of these per satellite (e.g. "Military/Government"),
// so it is modeled as a set, not a single value.
export type Sector = 'commercial' | 'government' | 'military' | 'civil';

// ── Purpose (from UCS "Purpose") ──────────────────────────────────────────────
// Normalized from the free-text UCS Purpose column. The long tail of combos
// (e.g. "Communications/Maritime Tracking") collapses to its primary purpose.
export type Purpose =
  | 'communications'
  | 'earth_observation'
  | 'navigation'
  | 'technology_dev'
  | 'space_science'
  | 'space_observation'
  | 'surveillance'
  | 'meteorological'
  | 'other';

// ── Operational status (from Space-Track SATCAT OPS_STATUS_CODE) ──────────────
// The live, meaningful status axis for in-orbit objects. Distinct from orbital
// status below: an object is "operational" vs "decayed" on different axes.
export type OperationalStatus =
  | 'operational'      // "+"
  | 'partial'          // "P"
  | 'nonoperational'   // "-"
  | 'backup'           // "B"
  | 'spare'            // "S"
  | 'extended'         // "X"
  | 'unknown';         // "" or no SATCAT entry

// ── Orbital status (from satcat.csv "status") ─────────────────────────────────
// Decayed/deorbited/beyond-earth objects have no current TLE, so they never
// render on the live globe; this axis is for the data view + history track.
export type OrbitalStatus =
  | 'in_orbit'
  | 'decayed'
  | 'deorbited'
  | 'beyond_earth'
  | 'exploded'
  | 'unknown';

// ── Object type (superset of the live model — adds Component) ──────────────────
export type CatalogObjectType =
  | 'payload'
  | 'rocket_body'
  | 'debris'
  | 'component'
  | 'unknown';

// ── Provenance — which snapshot each record was joined from ───────────────────
export type MetadataSource = 'ucs-2023-05' | 'satcat-gc' | 'spacetrack';

// ============================================================
// The join record. Most fields are nullable — coverage is partial (UCS specs
// exist only for active payloads ≤ 2023-05). Empty sectors[] / purpose 'other'
// map to the UI's explicit "Unspecified" bucket.
// ============================================================
export interface ObjectMetadata {
  noradId: number;

  // Canonical operator country (Space-Track code; see country-codes.ts).
  operatorCountry: string | null;
  operatorOrg: string | null;          // owning organization, e.g. "SpaceX"

  // Sector + purpose (UCS-only).
  sectors: Sector[];                    // [] = unspecified
  purpose: Purpose;                     // 'other' = unspecified
  detailedPurpose: string | null;      // raw UCS sub-purpose

  // Status axes.
  operationalStatus: OperationalStatus; // live authority
  orbitalStatus: OrbitalStatus;         // snapshot/history authority
  objectType: CatalogObjectType;

  // Heavy specs (UCS-only) — served lazily via /api/metadata/:noradId, NOT inline.
  contractor: string | null;
  contractorCountry: string | null;
  launchSite: string | null;
  launchVehicle: string | null;
  launchMassKg: number | null;
  dryMassKg: number | null;
  powerW: number | null;
  expectedLifetimeYrs: number | null;
  cospar: string | null;               // international designator

  // Detailed orbit class from the General Catalog (e.g. "LLEO/I", "GEO/S").
  orbitClass: string | null;

  sources: MetadataSource[];           // provenance — which snapshots contributed
}

// ============================================================
// The compact facets actually inlined onto EnrichedTLEObject in /api/tle/all.
// Kept minimal to protect the ~13.8 MB payload; specs stay out of the hot path.
// (When wired, EnrichedTLEObject gains these four fields.)
// ============================================================
export interface InlineMetadataFacets {
  operatorCountry: string | null;
  sectors: Sector[];
  purpose: Purpose;
  operationalStatus: OperationalStatus;
}

/** Empty/unknown facets for objects with no metadata match (debris, post-2023 launches). */
export const EMPTY_FACETS: InlineMetadataFacets = {
  operatorCountry: null,
  sectors: [],
  purpose: 'other',
  operationalStatus: 'unknown',
};

// ── Normalization lookup tables (source vocab → canonical enum) ────────────────

/** UCS "Users" token → Sector. UCS combos are split on "/" then mapped per token. */
export const UCS_USER_TO_SECTOR: Record<string, Sector> = {
  Commercial: 'commercial',
  Government: 'government',
  Military: 'military',
  Civil: 'civil',
};

/** Space-Track OPS_STATUS_CODE → OperationalStatus. */
export const OPS_STATUS_TO_OPERATIONAL: Record<string, OperationalStatus> = {
  '+': 'operational',
  P: 'partial',
  '-': 'nonoperational',
  B: 'backup',
  S: 'spare',
  X: 'extended',
};

/** satcat.csv "status" → OrbitalStatus. */
export const SATCAT_STATUS_TO_ORBITAL: Record<string, OrbitalStatus> = {
  'In Orbit': 'in_orbit',
  Decayed: 'decayed',
  Deorbited: 'deorbited',
  'Beyond Earth Orbit': 'beyond_earth',
  Exploded: 'exploded',
};

/** satcat.csv "object_type" → CatalogObjectType. */
export const SATCAT_TYPE_TO_OBJECT: Record<string, CatalogObjectType> = {
  Payload: 'payload',
  'Rocket Body': 'rocket_body',
  Debris: 'debris',
  Component: 'component',
  Unknown: 'unknown',
};
