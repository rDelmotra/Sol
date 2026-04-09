/**
 * Checked-in DSO registry entries for OrbitWatch v1.
 *
 * Owns:
 * - the static list of DSOs supported by the backend pipeline
 * - pure lookup helpers over those checked-in entries
 *
 * Does not own:
 * - runtime freshness state
 * - cache paths
 * - manifests
 * - provider fetch logic
 * - imports from TLE-specific types or updater logic
 */

import type { DsoId, DsoRegistryEntry } from './types.js';

const DEFAULT_SAMPLE_STEP_SEC = 600;
const DEFAULT_REFRESH_INTERVAL_SEC = 21_600;
const DEFAULT_VALID_PAST_WINDOW_SEC = 864_000; // 10 days
const DEFAULT_VALID_FUTURE_WINDOW_SEC = 259_200; // 3 days

function createRegistryEntry(
  entry: Omit<
    DsoRegistryEntry,
    'sampleStepSec' | 'refreshIntervalSec' | 'validPastWindowSec' | 'validFutureWindowSec'
  >,
): DsoRegistryEntry {
  return {
    ...entry,
    sampleStepSec: DEFAULT_SAMPLE_STEP_SEC,
    refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
    validPastWindowSec: DEFAULT_VALID_PAST_WINDOW_SEC,
    validFutureWindowSec: DEFAULT_VALID_FUTURE_WINDOW_SEC,
  };
}

export const DSO_REGISTRY = [
  createRegistryEntry({
    dsoId: 'jwst',
    slug: 'jwst',
    displayName: 'James Webb Space Telescope',
    provider: 'horizons',
    providerObjectId: '-170',
    enabled: true,
    targetBody: 'other',
    regime: 'OTHER',
    mission: 'JWST',
    description: 'Infrared observatory operating near the Sun-Earth L2 region.',
    launchDate: '2021-12-25',
    searchAliases: ['webb', 'james webb', 'jwst'],
  }),
  createRegistryEntry({
    dsoId: 'dscovr',
    slug: 'dscovr',
    displayName: 'DSCOVR',
    provider: 'horizons',
    providerObjectId: '-78',
    enabled: true,
    targetBody: 'other',
    regime: 'OTHER',
    mission: 'DSCOVR',
    description: 'Space weather and Earth observation mission near the Sun-Earth L1 region.',
    launchDate: '2015-02-11',
    searchAliases: ['dscovr', 'deep space climate observatory'],
  }),
  createRegistryEntry({
    dsoId: 'lro',
    slug: 'lro',
    displayName: 'Lunar Reconnaissance Orbiter',
    provider: 'horizons',
    providerObjectId: '-85',
    enabled: true,
    targetBody: 'moon',
    regime: 'LUNAR',
    mission: 'LRO',
    description: 'NASA lunar orbiter mapping the Moon from polar orbit.',
    launchDate: '2009-06-18',
    searchAliases: ['lro', 'lunar reconnaissance orbiter'],
  }),
  createRegistryEntry({
    dsoId: 'artemis-ii',
    slug: 'artemis-ii',
    displayName: 'Artemis II',
    provider: 'horizons',
    providerObjectId: 'TBD',
    enabled: false,
    targetBody: 'moon',
    regime: 'LUNAR',
    mission: 'Artemis II',
    description: 'Crewed lunar mission entry kept disabled until Horizons coverage is verified.',
    launchDate: null,
    searchAliases: ['artemis', 'artemis ii'],
  }),
  createRegistryEntry({
    dsoId: 'chandrayaan3',
    slug: 'chandrayaan3',
    displayName: 'Chandrayaan-3 Orbiter',
    provider: 'horizons',
    providerObjectId: '-156',
    enabled: false,
    targetBody: 'moon',
    regime: 'LUNAR',
    mission: 'Chandrayaan-3',
    description: 'Lunar mission entry kept disabled until Horizons coverage is explicitly confirmed.',
    launchDate: '2023-07-14',
    searchAliases: ['chandrayaan', 'chandrayaan 3', 'chandrayaan-3'],
  }),
] as const satisfies readonly DsoRegistryEntry[];

export const dsoRegistryById = new Map<DsoId, DsoRegistryEntry>(
  DSO_REGISTRY.map((entry) => [entry.dsoId, entry]),
);

export function getDsoRegistryEntry(dsoId: DsoId): DsoRegistryEntry | undefined {
  return dsoRegistryById.get(dsoId);
}

export function getEnabledDsoRegistryEntries(): DsoRegistryEntry[] {
  return DSO_REGISTRY.filter((entry) => entry.enabled);
}
