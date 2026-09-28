/**
 * DSO registry contracts.
 *
 * Owns:
 * - the checked-in shape of future DSO registry entries
 *
 * Does not own:
 * - runtime state
 * - manifests
 * - provider fetch results
 * - imports from TLE-specific types or updater logic
 *
 * DsoId/DsoProvider/DsoTargetBody/DsoRegime moved to @orbitwatch/contracts in
 * C2a (shared with the frontend DSO client). DsoRegistryEntry stays here —
 * it is a backend-only checked-in shape, never serialized to the frontend.
 */

import type { DsoId, DsoProvider, DsoRegime, DsoTargetBody } from '@orbitwatch/contracts';

export interface DsoRegistryEntry {
  dsoId: DsoId;
  slug: string;
  displayName: string;
  provider: DsoProvider;
  providerObjectId: string;
  enabled: boolean;
  targetBody: DsoTargetBody;
  regime: DsoRegime;
  sampleStepSec: number;
  refreshIntervalSec: number;
  validPastWindowSec: number;
  validFutureWindowSec: number;
  mission: string;
  description: string | null;
  searchAliases: string[];
  launchDate?: string | null;
}
