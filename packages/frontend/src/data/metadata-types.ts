// ============================================================
// Metadata enrichment — frontend-local types
//
// The wire/domain types (Sector, Purpose, OperationalStatus, OrbitalStatus,
// MetadataSource, FacetProvenance, GcatRawCodes, ObjectMetadata,
// InlineMetadataFacets, DecayedCatalogRow, PROGRAM_LABELS) live in
// @orbitwatch/contracts, and so do the read-model shapes (LaunchInfo, OrgRef,
// ObjectMetadataResponse) — import them from there. What's left here is
// package-local: SectorFilterKey, a UI-only filter-key extension.
//
// The SECTOR/PURPOSE/ORBITAL_STATUS label maps lived here for the old
// FilterPanel and the query alias table; both are gone, so the maps were removed.
//
// See my_plans/old/metadata_enrichment.md.
// ============================================================

import type { Sector } from '@orbitwatch/contracts';

/** Sector filter key space: the four real sectors plus an explicit "no UCS match". */
export type SectorFilterKey = Sector | 'unspecified';
