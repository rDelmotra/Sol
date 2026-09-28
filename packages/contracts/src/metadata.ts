// ============================================================
// @orbitwatch/contracts — metadata.ts
//
// The GCAT/UCS enrichment join record + its inline/served projections. Step
// C2a of PROJECT_MAP/15_ORBITAL_CORE_AND_CONTRACTS.md — moved verbatim from
// backend `enrichment/types.ts` (source of truth; `CatalogObjectType` there
// is renamed `AnalyticObjectType` here to disambiguate from the wire-spelled
// `ObjectType` in tle.ts — see enums.ts's NAMING note). Backend keeps
// `emptyObjectMetadata`/`EMPTY_FACETS`/`EnrichmentArtifactMeta` and the UCS/
// OPS/SATCAT normalization maps package-local (build-time helpers, not wire
// shapes). See my_plans/old/metadata_enrichment.md for the design rationale.
// ============================================================

import type { AnalyticObjectType, MetadataSource, OperationalStatus, OrbitalStatus, Purpose, Sector } from './enums.js';

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
  objectType: AnalyticObjectType;

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
  objectType: AnalyticObjectType;
  orbitClass: string | null;
  launchYear: number | null;
}
