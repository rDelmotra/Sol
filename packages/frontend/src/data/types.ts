// ============================================================
// TLE catalog wire types.
//
// ObjectType, ObjectCategory, OrbitalRegime and EnrichedTLEObject (the shape
// served by GET /api/tle/all) moved to @orbitwatch/contracts in C2b — import
// them from there. What's left here is package-local: TLEInput (the client's
// satellite.js input shape), CatalogType (the UI type-filter key space —
// extends the wire ObjectType with 'deep_space' for DSO objects), FacetCounts
// + its factory helpers. The SGP4 worker message protocol lives in workers/sgp4-protocol.ts.
// ============================================================

import type { OMMJsonObject } from 'satellite.js';
import type { ObjectType, OrbitalStatus, Purpose } from '@orbitwatch/contracts';
import type { SectorFilterKey } from './metadata-types';
import { TYPE_KEYS, STATUS_KEYS, SECTOR_KEYS, PURPOSE_KEYS, zeros } from './facets';

export interface TLEInput {
    noradId: number
    omm: OMMJsonObject
}

/** Observer position on the ground: degrees, degrees, km. (NOT the {latDeg, lonDeg, altKm} orbital-core shape.) */
export interface GeodeticObserver { lat: number; lon: number; alt: number } // deg, deg, km

/** Type-filter key space: the live ObjectType plus 'deep_space' for DSO objects. */
export type CatalogType = ObjectType | 'deep_space';

// ── Per-facet tallies (Phase B) ───────────────────────────────────────────────
// Lives here (not in the store) so the pure data tier — buildCatalogResult and
// its unit test — can build counts without importing the engine-coupled store.

/** Per-group object tallies (total or visible). Country is a dynamic histogram. */
export interface FacetCounts {
  type: Record<CatalogType, number>;
  status: Record<OrbitalStatus, number>;
  sector: Record<SectorFilterKey, number>;
  purpose: Record<Purpose, number>;
  country: Record<string, number>;
}

/** A fresh zeroed FacetCounts (country starts empty — keys appear as the catalog loads). */
export function emptyFacetCounts(): FacetCounts {
  return {
    type: zeros(TYPE_KEYS),
    status: zeros(STATUS_KEYS),
    sector: zeros(SECTOR_KEYS),
    purpose: zeros(PURPOSE_KEYS),
    country: {},
  };
}

/** Deep-copy a FacetCounts (each per-group record cloned) so totals and visible diverge safely. */
export function cloneFacetCounts(src: FacetCounts): FacetCounts {
  return {
    type: { ...src.type },
    status: { ...src.status },
    sector: { ...src.sector },
    purpose: { ...src.purpose },
    country: { ...src.country },
  };
}
