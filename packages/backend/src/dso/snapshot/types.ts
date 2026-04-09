/**
 * DSO snapshot and read-model contracts.
 *
 * Owns:
 * - published DSO snapshot shapes
 * - manifest and catalog read-model contracts
 *
 * Does not own:
 * - provider-specific fetch logic
 * - refresh orchestration
 * - imports from TLE-specific types or updater logic
 */

import type {
  DsoId,
  DsoProvider,
  DsoRegime,
  DsoTargetBody,
} from '../registry/index.js';
import type { CanonicalStateVector } from '../normalize/index.js';

export type DsoFreshnessState = 'fresh' | 'stale' | 'degraded' | 'unavailable';
export type DsoSourceFrame = 'J2000' | (string & {});

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
