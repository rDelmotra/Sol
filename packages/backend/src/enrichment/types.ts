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
// 'gcat'      = full GCAT satcat/psatcat snapshot (supersedes the old trimmed
//               'satcat-gc' CSV as of G1 — see my_plans/gcat_ingestion_architecture.md)
// 'gcat-org'  = facet resolved via the Owner→orgs.tsv Class join (G2) — still
//               SOURCE data (a join of two GCAT tables), not inference
// 'inferred'  = filled from the program registry (programs.ts) by name-pattern
//               matching, not looked up in a source. Appended to sources[]
//               whenever the matcher contributed anything (membership/facets).
// 'inherited' = relational inference (G2): Parent-JCAT walk to the ancestor
//               payload, or launch-payload-majority — never overwrites non-empty
export type MetadataSource =
  | 'ucs-2023-05'
  | 'gcat'
  | 'gcat-org'
  | 'spacetrack'
  | 'inferred'
  | 'inherited';

// ── Per-facet provenance ───────────────────────────────────────────────────────
// Present for facets filled by program inference ('inferred') or by the GCAT
// psatcat/satcat join ('gcat'); absence of a key means the value came from UCS
// per the record-level sources[] semantics. NEVER assign an empty {} — the
// build script's slim() replacer drops nulls/empty arrays but not empty objects.
export interface FacetProvenance {
  sectors?: MetadataSource;
  purpose?: MetadataSource;
  country?: MetadataSource;
  org?: MetadataSource;
  program?: MetadataSource;   // set only for inherited program membership (G2)
}

// ── Raw GCAT codes (reversibility block) ───────────────────────────────────────
// Verbatim trimmed source cells for every normalized facet. Only assigned when
// at least one key is present (slim() drops nulls/empty arrays, NOT empty {}).
export interface GcatRawCodes {
  status?: string;        // satcat Status ("O", "AR", "R?", …)
  type?: string;          // full satcat Type cell ("PPTH-MU", "CP E-I", …)
  parent?: string;        // verbatim Parent cell (may carry '*' / port suffix)
  clas?: string;          // psatcat Clas ("B", "CD", …)
  category?: string;      // full psatcat Category cell ("COM/MET-RO", "SIG?*")
  program?: string;       // psatcat Program (duplicated to gcatProgram for reach)
  opOrbit?: string;       // satcat OpOrbit+OQU cell ("LLEO/I -")
  owner?: string;         // GCAT org code ("SPXS") — name resolution is G2
  state?: string;         // GCAT state code pre-canonicalization ("SU", "I-ESA")
  manufacturer?: string;  // GCAT org code
}

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

  // ── GCAT satcat/psatcat fields (G1) — lazy-served, never inlined ────────────
  jcat?: string;                // GCAT universal id (S25544, …)
  parentJcat?: string;          // separation-tree parent (first token, '*' stripped)
  launchTag?: string;           // GCAT launch key ("1998-067") — launches.json join
  launchDate?: string;          // raw GCAT vague date ("1998 Nov 20 0649:47")
  bus?: string;
  motor?: string;
  shape?: string;
  lengthM?: number;
  diameterM?: number;
  spanM?: number;
  totMassKg?: number;           // GCAT TotMass — attached-group total at launch
  gcatProgram?: string;         // raw GCAT program string ("Starlink 2MO S1");
                                // `program` below stays the registry SLUG
  maneuverability?: 'M' | 'D';  // psatcat Mvr: M=maneuverable, D=deorbit-capable
  attitudeControl?: string;     // psatcat Att code (P, S, G, U, …)
  plane?: string;               // constellation plane/shell label
  // psatcat operational timeline (raw vague dates; a '*' cell = "believed still
  // active/operating/transmitting" and is OMITTED here — see ingest.ts)
  lastActiveDate?: string;      // TLast
  endOpDate?: string;           // TOp
  endTransmitDate?: string;     // TDate
  // Raw GCAT code block — verbatim trimmed cells (uncertainty '?' kept), so every
  // normalization above is reversible without re-reading the snapshot files.
  gcat?: GcatRawCodes;

  // Program membership (programs.ts registry id, e.g. 'starlink'). Stamped on
  // every payload whose name matches a registry entry, independent of whether
  // any facets were inferred from it.
  program?: string;
  // Per-facet inference provenance — see FacetProvenance above.
  facetProvenance?: FacetProvenance;

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
  // Orbital status from the McDowell satcat.csv (in_orbit / decayed / ...). This
  // is the source of the "status" filter — Space-Track does NOT expose operational
  // status. On the live globe this is ~all 'in_orbit' (every object has a current
  // TLE); decayed/deorbited objects live in the decayed-catalog browser.
  status: OrbitalStatus;
  // Program membership (registry id). Optional + omitted when absent to keep
  // the hot /api/tle/all payload lean.
  program?: string;
  // GCAT launch tag ("2019-074", pre-1963 "1957 ALP") — the launch/vehicle/site
  // query facets' join key (G3). Omitted when the record has none.
  launchTag?: string;
  // Primary owner org code (first token of gcat.owner, '?' stripped) — the
  // operator query facet (G3). Omitted when unknown.
  owner?: string;
}

/** Fresh all-unknown join record — shared by the GCAT and UCS ingest passes. */
export function emptyObjectMetadata(noradId: number): ObjectMetadata {
  return {
    noradId,
    operatorCountry: null,
    operatorOrg: null,
    sectors: [],
    purpose: 'other',
    detailedPurpose: null,
    operationalStatus: 'unknown',
    orbitalStatus: 'unknown',
    objectType: 'unknown',
    contractor: null,
    contractorCountry: null,
    launchSite: null,
    launchVehicle: null,
    launchMassKg: null,
    dryMassKg: null,
    powerW: null,
    expectedLifetimeYrs: null,
    cospar: null,
    orbitClass: null,
    sources: [],
  };
}

/** Empty/unknown facets for objects with no metadata match (debris, post-2023 launches). */
export const EMPTY_FACETS: InlineMetadataFacets = {
  operatorCountry: null,
  sectors: [],
  purpose: 'other',
  status: 'unknown',
};

// ============================================================
// Decayed-catalog browser row — a SLIM projection (not the full ObjectMetadata)
// for the non-rendered "browse decayed/deorbited objects" panel. Built from
// satcat.csv for orbitalStatus ∈ {decayed, deorbited, exploded}.
// ============================================================
export interface DecayedCatalogRow {
  noradId: number;
  name: string;
  country: string | null;       // canonical operator code (see country-codes.ts)
  status: OrbitalStatus;
  objectType: CatalogObjectType;
  orbitClass: string | null;
  launchYear: number | null;
}

// ── Artifact envelope (G1) ─────────────────────────────────────────────────────
// Every committed enrichment artifact wraps its data in { meta, objects|rows }
// so snapshot provenance + citation ship with the data (CC-BY requirement).
export interface EnrichmentArtifactMeta {
  source: string;         // "GCAT (J. McDowell, planet4589.org/space/gcat)"
  license: string;        // "CC-BY 4.0"
  gcatSnapshot: string | null;  // from the file's "# Updated …" line
  ucsSnapshot: string;    // "2023-05-01"
  builtAt: string;        // ISO timestamp of the build run
  recordCount: number;
}

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
