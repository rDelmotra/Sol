import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeUnavailableBackoffMs,
  getUnavailableRetryDelayMs,
  shouldRefreshDsoEntry,
} from '../../../src/dso/worker/retry-policy.ts';
import type { DsoRegistryEntry } from '../../../src/dso/registry/types.ts';
import type { DsoObjectStatus } from '@orbitwatch/contracts';

const entry: DsoRegistryEntry = {
  dsoId: 'artemis-ii',
  slug: 'artemis-ii',
  displayName: 'Artemis II',
  provider: 'horizons',
  providerObjectId: '-1024',
  enabled: true,
  targetBody: 'moon',
  regime: 'LUNAR',
  sampleStepSec: 600,
  refreshIntervalSec: 21_600,
  validPastWindowSec: 864_000,
  validFutureWindowSec: 21_600,
  mission: 'Artemis II',
  description: null,
  searchAliases: ['artemis'],
  launchDate: '2026-04-03',
};

function unavailableStatus(
  failureCount: number,
  lastFailureAt: string,
): DsoObjectStatus {
  return {
    enabled: true,
    provider: 'horizons',
    providerObjectId: '-1024',
    currentSnapshotVersion: null,
    freshnessState: 'unavailable',
    validFrom: null,
    validTo: null,
    lastSuccessAt: null,
    lastFailureAt,
    failureCount,
    availability: false,
    snapshotPath: null,
  };
}

describe('DSO retry policy', () => {
  it('uses exponential unavailable backoff capped at 30 minutes', () => {
    assert.equal(computeUnavailableBackoffMs(1), 60_000);
    assert.equal(computeUnavailableBackoffMs(2), 120_000);
    assert.equal(computeUnavailableBackoffMs(3), 240_000);
    assert.equal(computeUnavailableBackoffMs(10), 1_800_000);
    assert.equal(computeUnavailableBackoffMs(20), 1_800_000);
  });

  it('returns remaining delay for unavailable failed entries', () => {
    const now = new Date('2026-04-09T12:05:00.000Z');
    const status = unavailableStatus(1, '2026-04-09T12:04:30.000Z');
    const delay = getUnavailableRetryDelayMs(status, now);
    assert.equal(delay, 30_000);
  });

  it('suppresses refresh before backoff elapses for unavailable entries', () => {
    const status = unavailableStatus(2, '2026-04-09T12:00:00.000Z');
    const tooSoon = new Date('2026-04-09T12:01:30.000Z'); // 90s < 120s backoff
    const ready = new Date('2026-04-09T12:02:01.000Z');   // >=120s backoff

    assert.equal(shouldRefreshDsoEntry(entry, status, tooSoon), false);
    assert.equal(shouldRefreshDsoEntry(entry, status, ready), true);
  });

  it('refreshes immediately when no previous failure exists', () => {
    assert.equal(
      shouldRefreshDsoEntry(
        entry,
        {
          ...unavailableStatus(0, ''),
          lastFailureAt: null,
          failureCount: 0,
        },
        new Date('2026-04-09T12:00:00.000Z'),
      ),
      true,
    );
  });
});
