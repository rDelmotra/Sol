// ============================================================
// Metadata enrichment — frontend-local types + display labels
//
// The wire/domain types (Sector, Purpose, OperationalStatus, OrbitalStatus,
// MetadataSource, FacetProvenance, GcatRawCodes, ObjectMetadata,
// InlineMetadataFacets, DecayedCatalogRow, PROGRAM_LABELS) moved to
// @orbitwatch/contracts in C2b — import them from there. What's left here is
// package-local: SectorFilterKey (a UI-only filter-key extension), the
// LaunchInfo/OrgInfo/OrgRef/ObjectMetadataResponse read-model shapes (not yet
// shared — see PROJECT_MAP/15 C3), and the *_LABELS display maps (except
// programs, which now live in contracts).
//
// See my_plans/old/metadata_enrichment.md.
// ============================================================

import type { ObjectMetadata, OrbitalStatus, Purpose, Sector } from '@orbitwatch/contracts';

/** Sector filter key space: the four real sectors plus an explicit "no UCS match". */
export type SectorFilterKey = Sector | 'unspecified';

/** Launch entity row (launches.json / GET /api/launch/:tag). */
export interface LaunchInfo {
  tag: string;
  date: string;
  lvType: string;
  lvFamily: string | null;
  variant: string | null;
  flightId: string | null;
  mission: string | null;
  site: string | null;
  siteName: string | null;
  pad: string | null;
  platform: string | null;
  agencies: string[];
  code: string;
  success: boolean | null;
  category: string | null;
  group: string | null;
  orbPay: number | null;
  /** Resolved agency display names — embedded by the metadata route. */
  agencyNames?: string[];
}

/** Organization entity row (orgs.json / GET /api/org/:code). */
export interface OrgInfo {
  code: string;
  name: string;
  stateCode: string | null;
  cls: string | null;
  sectors: Sector[];
  type: string | null;
  parent: string | null;
  lat: number | null;
  lon: number | null;
  tstart: string | null;
  tstop: string | null;
}

/** Slim org reference embedded in the metadata response. */
export interface OrgRef {
  code: string;
  name: string;
  sectors: Sector[];
}

/** What GET /api/metadata/:noradId actually returns — record + composed context. */
export type ObjectMetadataResponse = ObjectMetadata & {
  launch?: LaunchInfo;
  ownerOrg?: OrgRef;
  manufacturerOrg?: OrgRef;
};

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
