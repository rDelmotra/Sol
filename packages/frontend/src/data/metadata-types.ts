// ============================================================
// Metadata enrichment — frontend type mirror
//
// Mirrors packages/backend/src/enrichment/types.ts. The InlineMetadataFacets
// (operatorCountry, sectors, purpose, status) are merged onto EnrichedTLEObject
// (data/types.ts); the full ObjectMetadata is fetched lazily from
// /api/metadata/:noradId for the InfoCard "Specifications" section (Phase C).
//
// See my_plans/metadata_enrichment.md.
// ============================================================

export type Sector = 'commercial' | 'government' | 'military' | 'civil';

/** Sector filter key space: the four real sectors plus an explicit "no UCS match". */
export type SectorFilterKey = Sector | 'unspecified';

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

/** Operational status (vestigial — Space-Track no longer exposes it; always 'unknown'). */
export type OperationalStatus =
  | 'operational'
  | 'partial'
  | 'nonoperational'
  | 'backup'
  | 'spare'
  | 'extended'
  | 'unknown';

/** Orbital status from the McDowell satcat.csv — the live "status" facet. */
export type OrbitalStatus =
  | 'in_orbit'
  | 'decayed'
  | 'deorbited'
  | 'beyond_earth'
  | 'exploded'
  | 'unknown';

export type CatalogObjectType =
  | 'payload'
  | 'rocket_body'
  | 'debris'
  | 'component'
  | 'unknown';

export type MetadataSource = 'ucs-2023-05' | 'satcat-gc' | 'spacetrack';

/** Compact facets inlined onto EnrichedTLEObject (cheap to filter, hot-path safe). */
export interface InlineMetadataFacets {
  operatorCountry: string | null;
  sectors: Sector[];
  purpose: Purpose;
  status: OrbitalStatus;
}

/** Full record, lazy-loaded from /api/metadata/:noradId for the InfoCard (Phase C). */
export interface ObjectMetadata {
  noradId: number;
  operatorCountry: string | null;
  operatorOrg: string | null;
  sectors: Sector[];
  purpose: Purpose;
  detailedPurpose: string | null;
  operationalStatus: OperationalStatus;
  orbitalStatus: OrbitalStatus;
  objectType: CatalogObjectType;
  contractor: string | null;
  contractorCountry: string | null;
  launchSite: string | null;
  launchVehicle: string | null;
  launchMassKg: number | null;
  dryMassKg: number | null;
  powerW: number | null;
  expectedLifetimeYrs: number | null;
  cospar: string | null;
  orbitClass: string | null;
  sources: MetadataSource[];
}

/** Slim row for the decayed-catalog browser (GET /api/catalog/decayed) — Phase D. */
export interface DecayedCatalogRow {
  noradId: number;
  name: string;
  country: string | null;
  status: OrbitalStatus;
  objectType: CatalogObjectType;
  orbitClass: string | null;
  launchYear: number | null;
}

// ── Display labels for the FilterPanel groups + Legend (Phase B6/B7) ───────────

export const SECTOR_LABELS: Record<SectorFilterKey, string> = {
  commercial: 'Commercial',
  government: 'Government',
  military: 'Military',
  civil: 'Civil',
  unspecified: 'Unspecified',
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
  communications: 'Communications',
  earth_observation: 'Earth Observation',
  navigation: 'Navigation',
  technology_dev: 'Technology Development',
  space_science: 'Space Science',
  space_observation: 'Space Observation',
  surveillance: 'Surveillance',
  meteorological: 'Meteorological',
  other: 'Other / Unspecified',
};

export const ORBITAL_STATUS_LABELS: Record<OrbitalStatus, string> = {
  in_orbit: 'In Orbit',
  decayed: 'Decayed',
  deorbited: 'Deorbited',
  beyond_earth: 'Beyond Earth Orbit',
  exploded: 'Exploded',
  unknown: 'Unknown',
};
