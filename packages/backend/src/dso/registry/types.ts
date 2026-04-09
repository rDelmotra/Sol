/**
 * DSO registry contracts.
 *
 * Owns:
 * - DSO identity and control-plane definitions
 * - the checked-in shape of future DSO registry entries
 *
 * Does not own:
 * - runtime state
 * - manifests
 * - provider fetch results
 * - imports from TLE-specific types or updater logic
 */

export type DsoId = string;

export type DsoProvider = 'horizons' | 'spice';

export type DsoTargetBody = 'moon' | 'earth' | 'mars' | 'other';

export type DsoRegime = 'LUNAR' | 'CISLUNAR' | 'INTERPLANETARY' | 'OTHER';

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
