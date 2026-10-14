/**
 * DSO provider-facing contracts.
 *
 * Owns:
 * - source adapter fetch result shapes
 * - provider-native vector sample types
 *
 * Does not own:
 * - Express integration
 * - cache files
 * - manifests
 * - imports from TLE-specific types or updater logic
 */

import type { DsoProvider } from '@orbitwatch/contracts';
import type { DsoRegistryEntry } from '../registry/index.js';

export interface ProviderSample {
  julianDayTdb: number;
  // Human-readable Horizons calendar timestamp in the TDB timescale.
  // This is intentionally not a machine-parseable UTC ISO timestamp.
  calendarTimestampTdb: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface ProviderFetchResult {
  provider: DsoProvider;
  providerObjectId: string;
  sourceFrame: string;
  sourceUnits: string;
  timeScale: 'TDB';
  fetchedAt: string;
  sourceRevisionAt: string | null;
  samples: ProviderSample[];
  /**
   * Set when the provider's data for this target ended more than a day ago, so the
   * fetch had to be clamped to the data that exists. The worker marks the object as
   * ended and stops refreshing it. Absent or null for a live target.
   */
  coverageEndedAt?: string | null;
}

export interface DsoProviderAdapter {
  fetchEphemeris(
    entry: DsoRegistryEntry,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ProviderFetchResult>;
}
