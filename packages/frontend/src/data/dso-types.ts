/**
 * Frontend DSO types — mirrors backend DsoCatalog/DsoSnapshot shapes.
 * No cross-package imports; these are defined from the API contract.
 */

export type DsoFreshnessState = 'fresh' | 'stale' | 'degraded' | 'unavailable';

export type DsoRegime = 'LUNAR' | 'CISLUNAR' | 'INTERPLANETARY' | 'OTHER';

/** [timestampIso, x, y, z, vx, vy, vz] — TEME, earth_radii */
export type CanonicalStateVector = [string, number, number, number, number, number, number];

export interface DsoCatalogEntry {
  dsoId: string;
  slug: string;
  displayName: string;
  mission: string;
  targetBody: string;
  regime: DsoRegime;
  provider: string;
  availability: boolean;
  freshnessState: DsoFreshnessState;
  currentSnapshotVersion: string | null;
  validFrom: string | null;
  validTo: string | null;
  searchAliases: string[];
}

export interface DsoCatalog {
  catalogVersion: string;
  generatedAt: string;
  objects: DsoCatalogEntry[];
}

export interface DsoSnapshot {
  dsoId: string;
  snapshotVersion: string;
  provider: string;
  sourceObjectId: string;
  sourceFrame: string;
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

export interface DsoManifest {
  generatedAt: string;
  workerLastRunAt: string | null;
  objects: Record<string, DsoManifestObjectStatus>;
}

export interface DsoManifestObjectStatus {
  enabled: boolean;
  provider: string;
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

/**
 * Frontend-local DSO object — the product of merging a DsoCatalogEntry
 * with its loaded ephemeris state.
 */
export interface DsoObject {
  source: 'dso';
  dsoId: string;
  slug: string;
  name: string;
  mission: string;
  targetBody: string;
  regime: DsoRegime;
  provider: string;
  freshnessState: DsoFreshnessState;
  searchAliases: string[];
}
