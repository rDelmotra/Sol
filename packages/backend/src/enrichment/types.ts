// ============================================================
// Metadata enrichment — build-time helpers + normalization tables
//
// One join record per cataloged object, keyed by NORAD ID. Aggregates the
// richest available metadata across three sources (live Space-Track, the
// McDowell General Catalog snapshot, and the UCS Satellite Database snapshot),
// each normalized to the source's own terminology.
//
// The wire/domain types (Sector, Purpose, OperationalStatus, OrbitalStatus,
// ObjectMetadata, InlineMetadataFacets, DecayedCatalogRow, ...) moved to
// @orbitwatch/contracts in C2a — import them from there. What's left here is
// package-local: build-time factory/default helpers and the source-vocabulary
// normalization tables (never served on the wire).
//
// See my_plans/old/metadata_enrichment.md for the design rationale and per-facet
// source authority.
// ============================================================

import type {
  AnalyticObjectType,
  InlineMetadataFacets,
  ObjectMetadata,
  OperationalStatus,
  OrbitalStatus,
  Sector,
} from '@orbitwatch/contracts';

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

// ── Artifact envelope (G1) ─────────────────────────────────────────────────────
// Every committed enrichment artifact wraps its data in { meta, objects|rows }
// so snapshot provenance + citation ship with the data (CC-BY requirement).
export interface EnrichmentArtifactMeta {
  source: string;         // "GCAT (J. McDowell, planet4589.org/space/gcat)"
  license: string;        // "CC-BY 4.0"
  gcatSnapshot: string | null;  // from the file's "# Updated …" line — the real provenance
  ucsSnapshot: string;    // "2023-05-01"
  // NOTE: no wall-clock build timestamp on purpose — it would make every rebuild
  // of unchanged data produce different bytes (→ pointless git churn on the
  // gzipped artifact). gcatSnapshot/ucsSnapshot record which data this is from.
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

/** satcat.csv "object_type" → AnalyticObjectType. */
export const SATCAT_TYPE_TO_OBJECT: Record<string, AnalyticObjectType> = {
  Payload: 'payload',
  'Rocket Body': 'rocket_body',
  Debris: 'debris',
  Component: 'component',
  Unknown: 'unknown',
};
