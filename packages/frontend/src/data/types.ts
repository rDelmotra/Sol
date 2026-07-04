import type { OMMJsonObject } from 'satellite.js';
import type { Sector, Purpose, OrbitalStatus, SectorFilterKey } from './metadata-types';

export interface TLEInput {
    noradId: number
    omm: OMMJsonObject
}

export type ObjectCategory = 'active_satellite' | 'inactive_satellite' | 'rocket_body' | 'debris' | 'unknown' | 'deep_space';
export type OrbitalRegime = 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'OTHER';

/** Live object type (from Space-Track/CelesTrak GP OBJECT_TYPE). 'satellite' is a payload. */
export type ObjectType = 'satellite' | 'rocket_body' | 'debris' | 'unknown';

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
    type: { satellite: 0, rocket_body: 0, debris: 0, unknown: 0, deep_space: 0 },
    status: { in_orbit: 0, decayed: 0, deorbited: 0, beyond_earth: 0, exploded: 0, unknown: 0 },
    sector: { commercial: 0, government: 0, military: 0, civil: 0, unspecified: 0 },
    purpose: {
      communications: 0, earth_observation: 0, navigation: 0, technology_dev: 0,
      space_science: 0, space_observation: 0, surveillance: 0, meteorological: 0, other: 0,
    },
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

export interface EnrichedTLEObject {
  noradId: number;
  name: string;
  omm: OMMJsonObject;
  objectType: ObjectType;
  category: ObjectCategory;
  regime: OrbitalRegime;
  countryCode: string;
  launchDate: string | null;
  period: number;
  apogee: number;
  perigee: number;
  inclination: number;
  rcsSize: string | null;
  epoch: string;
  // ── Inline metadata facets (joined on the backend; mirror of EnrichedTLEObject) ──
  // status = orbital status from satcat.csv; sectors/purpose from the UCS join
  // (program-registry inference fills the gaps for unmatched payloads).
  sectors: Sector[];
  purpose: Purpose;
  status: OrbitalStatus;
  // Program membership slug (e.g. 'starlink'); omitted when unmatched.
  program?: string;
}

export type WorkerInMessage =
    | { type: 'INIT'; tles: TLEInput[]; startIndex: number }
    | { type: 'PROPAGATE'; timestamp: number; seq: number }

export type WorkerOutMessage =
    | { type: 'READY'; objectCount: number }
    | {
      type: 'POSITIONS';
      positions: Float32Array;
      velocities: Float32Array;
      validFlags: Uint8Array;
      startIndex: number;
      timestamp: number;
      seq: number;
    }
