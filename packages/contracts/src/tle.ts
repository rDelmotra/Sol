// ============================================================
// @orbitwatch/contracts — tle.ts
//
// The wire shape served by GET /api/tle/all and consumed by both the SGP4
// worker (frontend) and the file cache / analytic providers (backend).
// Step C2a of PROJECT_MAP/15_ORBITAL_CORE_AND_CONTRACTS.md — moved verbatim
// from backend `types/index.ts` (source of truth). `OMMJsonObject` is
// satellite.js's own type; re-exported here (type-only) so both packages
// share one import path for the OMM shape without contracts taking a second
// runtime dependency (`contracts-is-leaf` allows this one type-only import).
// ============================================================

import type { OMMJsonObject } from 'satellite.js';
import type { ObjectType, ObjectCategory, OrbitalRegime, Sector, Purpose, OrbitalStatus } from './enums.js';

/** Re-export so every package shares one source of truth for the OMM shape. */
export type { OMMJsonObject };

// Fully enriched object — this is what gets cached and served to clients.
export interface EnrichedTLEObject {
  noradId: number;
  name: string;
  omm: OMMJsonObject;            // OMM mean elements (for SGP4 propagation on client)
  objectType: ObjectType;
  category: ObjectCategory;
  regime: OrbitalRegime;
  countryCode: string;
  launchDate: string | null;
  period: number;                // minutes
  apogee: number;                // km
  perigee: number;               // km
  inclination: number;           // degrees
  rcsSize: string | null;
  epoch: string;                 // ISO timestamp of the TLE epoch
  // ── Inline metadata facets (joined in the cron from the enrichment store) ──
  // status = orbital status from the McDowell satcat.csv (in_orbit/decayed/...);
  // sectors/purpose come from the UCS join ([] / 'other' when unmatched).
  sectors: Sector[];
  purpose: Purpose;
  status: OrbitalStatus;
  // Program membership (programs.ts registry slug, e.g. 'starlink'). Omitted
  // when the object matches no program, keeping the hot payload lean.
  program?: string;
  // GCAT launch tag ("2019-074") — the launch/vehicle/site query facets' join
  // key (G3). Omitted when the enrichment record has none.
  launchTag?: string;
  // Primary owner org code ("SPXS") — the operator query facet (G3).
  owner?: string;
}
