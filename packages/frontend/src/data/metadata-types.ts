// ============================================================
// Metadata enrichment — frontend type mirror
//
// Mirrors packages/backend/src/enrichment/types.ts. The four InlineMetadataFacets
// get merged onto EnrichedTLEObject (data/types.ts) when the live join is wired;
// the full ObjectMetadata is fetched lazily from /api/metadata/:noradId for the
// InfoCard "Specifications" section. NOT YET WIRED.
//
// See my_plans/metadata_enrichment.md.
// ============================================================

export type Sector = 'commercial' | 'government' | 'military' | 'civil';

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

export type OperationalStatus =
  | 'operational'
  | 'partial'
  | 'nonoperational'
  | 'backup'
  | 'spare'
  | 'extended'
  | 'unknown';

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

/** Compact facets inlined onto EnrichedTLEObject (cheap to filter, hot-path safe). */
export interface InlineMetadataFacets {
  operatorCountry: string | null;
  sectors: Sector[];
  purpose: Purpose;
  operationalStatus: OperationalStatus;
}

/** Full record, lazy-loaded for the InfoCard. */
export interface ObjectMetadata extends InlineMetadataFacets {
  noradId: number;
  operatorOrg: string | null;
  detailedPurpose: string | null;
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
}

// ── Display labels for the (future) FilterPanel groups ────────────────────────

export const SECTOR_LABELS: Record<Sector, string> = {
  commercial: 'Commercial',
  government: 'Government',
  military: 'Military',
  civil: 'Civil',
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

export const OPERATIONAL_STATUS_LABELS: Record<OperationalStatus, string> = {
  operational: 'Operational',
  partial: 'Partially Operational',
  nonoperational: 'Non-operational',
  backup: 'Backup / Standby',
  spare: 'Spare',
  extended: 'Extended Mission',
  unknown: 'Unknown',
};
