// Fake provider records for the update-cycle tests. Not a test file (no .test.ts):
// it only builds plain objects that buildOmm() accepts. No network, no real data.

import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import type { CelesTrakGPElement, SpaceTrackGPElement } from '../../src/types/index.js';
import type { AttemptState } from '../../src/cache/attempt-log.js';

/** The attempt record without the daily-cap and alert fields (those have their own tests). */
export function attemptCore(state: AttemptState | null): Pick<AttemptState, 'lastAttemptAt' | 'lastOutcome' | 'consecutiveFailures'> | null {
  if (!state) return null;
  return {
    lastAttemptAt: state.lastAttemptAt,
    lastOutcome: state.lastOutcome,
    consecutiveFailures: state.consecutiveFailures,
  };
}

/** `n` valid Space-Track GP records (numbers as strings, like the real API). */
export function spaceTrackGp(n: number, firstId = 90_000): SpaceTrackGPElement[] {
  return Array.from({ length: n }, (_, i) => ({
    NORAD_CAT_ID: String(firstId + i),
    OBJECT_NAME: `FAKE SAT ${firstId + i}`,
    OBJECT_ID: `2024-${String(i % 999).padStart(3, '0')}A`,
    OBJECT_TYPE: 'PAYLOAD',
    CLASSIFICATION_TYPE: 'U',
    TLE_LINE0: '0 FAKE',
    TLE_LINE1: '1 00000U 24000A   24001.00000000  .00000000  00000-0  00000-0 0  9990',
    TLE_LINE2: '2 00000  53.0000 100.0000 0001000  90.0000 270.0000 15.00000000    10',
    EPOCH: '2024-03-15T12:00:00.000000',
    MEAN_MOTION: '15.0',
    ECCENTRICITY: '0.0001',
    INCLINATION: '53.0',
    RA_OF_ASC_NODE: '100.0',
    ARG_OF_PERICENTER: '90.0',
    MEAN_ANOMALY: '270.0',
    EPHEMERIS_TYPE: '0',
    ELEMENT_SET_NO: '999',
    REV_AT_EPOCH: '10',
    BSTAR: '0.0001',
    MEAN_MOTION_DOT: '0.0',
    MEAN_MOTION_DDOT: '0.0',
    SEMIMAJOR_AXIS: '6900',
    PERIOD: '96.0',
    APOAPSIS: '540',
    PERIAPSIS: '530',
    RCS_SIZE: 'LARGE',
    COUNTRY_CODE: 'US',
    LAUNCH_DATE: '2024-01-01',
    SITE: 'AFETR',
    DECAY_DATE: '',
    FILE: '1',
    GP_ID: String(i),
  }));
}

/** `n` valid CelesTrak GP records (real JSON numbers). */
export function celesTrakGp(n: number, firstId = 80_000): CelesTrakGPElement[] {
  return Array.from({ length: n }, (_, i) => ({
    OBJECT_NAME: `FAKE CT ${firstId + i}`,
    OBJECT_ID: `2024-${String(i % 999).padStart(3, '0')}B`,
    EPOCH: '2024-03-15T12:00:00.000000',
    MEAN_MOTION: 15,
    ECCENTRICITY: 0.0001,
    INCLINATION: 53,
    RA_OF_ASC_NODE: 100,
    ARG_OF_PERICENTER: 90,
    MEAN_ANOMALY: 270,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: firstId + i,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 10,
    BSTAR: 0.0001,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0,
    TLE_LINE0: '0 FAKE',
    TLE_LINE1: '1 00000U 24000B   24001.00000000  .00000000  00000-0  00000-0 0  9990',
    TLE_LINE2: '2 00000  53.0000 100.0000 0001000  90.0000 270.0000 15.00000000    10',
    OBJECT_TYPE: 'PAYLOAD',
    RCS_SIZE: 'LARGE',
    COUNTRY_CODE: 'US',
    LAUNCH_DATE: '2024-01-01',
    SITE: 'AFETR',
    DECAY_DATE: null,
    PERIOD: 96,
    APOAPSIS: 540,
    PERIAPSIS: 530,
  }));
}

/** A stand-in for a cached catalog of `n` objects. writeCache only serialises it. */
export function fakeCatalog(n: number): EnrichedTLEObject[] {
  return Array.from({ length: n }, (_, i) => ({ noradId: 1 + i, name: `CACHED ${i}` }) as unknown as EnrichedTLEObject);
}
