// ============================================================
// Metadata enrichment — frontend-local types + display labels
//
// The wire/domain types (Sector, Purpose, OperationalStatus, OrbitalStatus,
// MetadataSource, FacetProvenance, GcatRawCodes, ObjectMetadata,
// InlineMetadataFacets, DecayedCatalogRow, PROGRAM_LABELS) moved to
// @orbitwatch/contracts in C2b; the LaunchInfo/OrgRef/ObjectMetadataResponse
// read-model shapes (GET /api/launch/:tag, GET /api/metadata/:noradId) moved
// there too in C3 — import them from there. `OrgInfo` (the GET /api/org/:code
// full record) had zero importers here and is superseded by contracts'
// `OrgRecord` (which additionally types `aliases?`, a field the backend
// actually sends). What's left here is package-local: SectorFilterKey (a
// UI-only filter-key extension) and the *_LABELS display maps (except
// programs, which live in contracts).
//
// See my_plans/old/metadata_enrichment.md.
// ============================================================

import type { ObjectMetadataResponse, OrbitalStatus, Purpose, Sector } from '@orbitwatch/contracts';

export type { ObjectMetadataResponse };

/** Sector filter key space: the four real sectors plus an explicit "no UCS match". */
export type SectorFilterKey = Sector | 'unspecified';

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
