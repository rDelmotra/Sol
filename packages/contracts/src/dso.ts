// ============================================================
// @orbitwatch/contracts — dso.ts
//
// Deep-Space Object (DSO) identity + snapshot/manifest read-model shapes,
// shared between the backend DSO worker/routes and the frontend DSO client.
// Step C2a of PROJECT_MAP/15_ORBITAL_CORE_AND_CONTRACTS.md — moved verbatim
// from backend `dso/registry/types.ts`, `dso/normalize/types.ts` and
// `dso/snapshot/types.ts` (source of truth). `DsoRegistryEntry` and the
// provider fetch-result shapes (`ProviderSample`/`ProviderFetchResult`/
// `DsoProviderAdapter`) stay package-local to the backend (they are never
// serialized to the frontend).
// ============================================================

export type DsoId = string;

export type DsoProvider = 'horizons' | 'spice';

export type DsoTargetBody = 'moon' | 'earth' | 'mars' | 'other';

export type DsoRegime = 'LUNAR' | 'CISLUNAR' | 'INTERPLANETARY' | 'OTHER';

export type DsoFreshnessState = 'fresh' | 'stale' | 'degraded' | 'unavailable';
export type DsoSourceFrame = 'J2000' | (string & {});

export type CanonicalStateVector = [
  timestampIso: string,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
];

export interface DsoSnapshot {
  dsoId: DsoId;
  snapshotVersion: string;
  provider: DsoProvider;
  sourceObjectId: string;
  sourceFrame: DsoSourceFrame;
  frame: 'TEME';
  distanceUnits: 'earth_radii';
  velocityUnits: 'earth_radii_per_second';
  sampleStepSec: number;
  fetchedAt: string;
  sourceRevisionAt: string | null;
  validFrom: string;
  validTo: string;
  freshnessState: DsoFreshnessState;
  stateVectors: CanonicalStateVector[];
}

export interface DsoCatalogEntry {
  dsoId: DsoId;
  slug: string;
  displayName: string;
  mission: string;
  targetBody: DsoTargetBody;
  regime: DsoRegime;
  provider: DsoProvider;
  availability: boolean;
  freshnessState: DsoFreshnessState;
  currentSnapshotVersion: string | null;
  validFrom: string | null;
  validTo: string | null;
  searchAliases: string[];
}

export interface DsoObjectStatus {
  enabled: boolean;
  provider: DsoProvider;
  providerObjectId: string;
  currentSnapshotVersion: string | null;
  freshnessState: DsoFreshnessState;
  validFrom: string | null;
  validTo: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
  availability: boolean;
  snapshotPath: string | null;
}

export interface DsoManifest {
  generatedAt: string;
  workerLastRunAt: string | null;
  objects: Record<DsoId, DsoObjectStatus>;
}

export interface DsoCatalog {
  catalogVersion: string;
  generatedAt: string;
  objects: DsoCatalogEntry[];
}
