// Horizons coverage clamp: the window is clamped at BOTH ends, a finished mission is
// reported as ended, and nothing here touches the network (the request is injected).

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import {
  EPHEMERIS_ENDED_GRACE_MS,
  extractCoverageBoundsFromError,
  isEphemerisEndedInPast,
  mergeCoverageBounds,
  planCoverageRetry,
} from '../../../src/dso/providers/horizons-coverage.ts';
import {
  HorizonsNetworkError,
  HorizonsObjectNotFoundError,
  HorizonsThrottleError,
  requestWithCoverageClamp,
  type HorizonsRequestFn,
} from '../../../src/dso/providers/horizons.ts';
import { DsoEphemerisEndedError } from '../../../src/dso/providers/ended-error.ts';
import type { ProviderFetchResult } from '../../../src/dso/providers/types.ts';
import type { DsoRegistryEntry } from '../../../src/dso/registry/types.ts';

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
  validPastWindowSec: 86_400_000,
  validFutureWindowSec: 21_600,
  mission: 'Artemis II',
  description: null,
  searchAliases: ['artemis'],
  launchDate: '2026-04-01',
};

// The production log, 2026-10-13: window = launch .. now + 6 h.
const NOW = new Date('2026-10-13T18:19:30.000Z');
const WINDOW_START = new Date('2026-04-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-10-14T00:19:30.000Z');

// The exact message from the production ERROR line, and its "prior to" sibling.
const PROD_AFTER_MESSAGE =
  'No ephemeris for target "Artemis II (spacecraft)" after A.D. 2026-APR-10 23:54:22.8576 TDB';
const PRIOR_MESSAGE =
  'No ephemeris for target "Artemis II (spacecraft)" prior to A.D. 2026-APR-02 01:58:32.3050 TDB';

function okResult(): ProviderFetchResult {
  return {
    provider: 'horizons',
    providerObjectId: '-1024',
    sourceFrame: 'ICRF',
    sourceUnits: 'KM-S',
    timeScale: 'TDB',
    fetchedAt: NOW.toISOString(),
    sourceRevisionAt: null,
    samples: [],
  };
}

/**
 * A fake Horizons holding data for [coverageStart, coverageEnd]. Like the real one it
 * names only ONE violated bound per error, the start first.
 */
function fakeHorizons(coverageStart: Date, coverageEnd: Date) {
  const calls: Array<{ start: Date; end: Date }> = [];
  const request: HorizonsRequestFn = async (_entry, start, end) => {
    calls.push({ start, end });
    if (start.getTime() < coverageStart.getTime()) {
      throw new HorizonsObjectNotFoundError(PRIOR_MESSAGE);
    }
    if (end.getTime() > coverageEnd.getTime()) {
      throw new HorizonsObjectNotFoundError(PROD_AFTER_MESSAGE);
    }
    return okResult();
  };
  return { request, calls };
}

describe('coverage bound parsing (production strings)', () => {
  it('reads the upper bound from the exact production error', () => {
    const bounds = extractCoverageBoundsFromError(PROD_AFTER_MESSAGE);
    assert.ok(bounds);
    assert.equal(bounds.earliestAvailable, null);
    assert.equal(bounds.latestAvailable?.toISOString(), '2026-04-10T23:54:22.857Z');
  });

  it('reads both bounds when one message carries both', () => {
    const bounds = extractCoverageBoundsFromError(`${PRIOR_MESSAGE}; ${PROD_AFTER_MESSAGE}`);
    assert.equal(bounds?.earliestAvailable?.toISOString(), '2026-04-02T01:58:32.305Z');
    assert.equal(bounds?.latestAvailable?.toISOString(), '2026-04-10T23:54:22.857Z');
  });

  it('merges bounds, keeping the strictest on each side', () => {
    const a = { earliestAvailable: new Date('2026-04-02T00:00:00Z'), latestAvailable: null };
    const b = { earliestAvailable: new Date('2026-04-03T00:00:00Z'), latestAvailable: new Date('2026-04-10T00:00:00Z') };
    const c = { earliestAvailable: null, latestAvailable: new Date('2026-04-09T00:00:00Z') };
    const merged = mergeCoverageBounds(mergeCoverageBounds(a, b), c);
    assert.equal(merged.earliestAvailable?.toISOString(), '2026-04-03T00:00:00.000Z');
    assert.equal(merged.latestAvailable?.toISOString(), '2026-04-09T00:00:00.000Z');
  });
});

describe('isEphemerisEndedInPast', () => {
  const at = (iso: string) => ({ earliestAvailable: null, latestAvailable: new Date(iso) });

  it('needs an end bound more than one day before now', () => {
    assert.equal(isEphemerisEndedInPast({ earliestAvailable: null, latestAvailable: null }, NOW), false);
    assert.equal(isEphemerisEndedInPast(at('2026-04-10T23:54:22Z'), NOW), true);
    assert.equal(isEphemerisEndedInPast(at(new Date(NOW.getTime() - EPHEMERIS_ENDED_GRACE_MS - 1).toISOString()), NOW), true);
    assert.equal(isEphemerisEndedInPast(at(new Date(NOW.getTime() - EPHEMERIS_ENDED_GRACE_MS).toISOString()), NOW), false);
    assert.equal(isEphemerisEndedInPast(at('2026-10-13T12:00:00Z'), NOW), false);
    assert.equal(isEphemerisEndedInPast(at('2027-01-01T00:00:00Z'), NOW), false);
  });
});

describe('planCoverageRetry', () => {
  it('retries with the intersection when both bounds are known', () => {
    const plan = planCoverageRetry(
      entry,
      WINDOW_START,
      WINDOW_END,
      {
        earliestAvailable: new Date('2026-04-02T01:58:32.305Z'),
        latestAvailable: new Date('2026-04-10T23:54:22.857Z'),
      },
      NOW,
    );
    assert.equal(plan.action, 'retry');
    if (plan.action === 'retry') {
      assert.equal(plan.window.windowStart.toISOString(), '2026-04-02T02:08:32.305Z');
      assert.equal(plan.window.windowEnd.toISOString(), '2026-04-10T23:44:22.857Z');
    }
  });

  it('says ended when the data stops before the window starts', () => {
    const plan = planCoverageRetry(
      entry,
      new Date('2026-05-01T00:00:00Z'),
      WINDOW_END,
      { earliestAvailable: null, latestAvailable: new Date('2026-04-10T23:54:22.857Z') },
      NOW,
    );
    assert.deepEqual(plan, { action: 'ended', endedAt: new Date('2026-04-10T23:54:22.857Z') });
  });

  it('uses the same 24 h grace as isEphemerisEndedInPast: data that stopped 2 hours ago is not ended', () => {
    const stoppedTwoHoursAgo = new Date(NOW.getTime() - 2 * 3_600_000);
    const plan = planCoverageRetry(
      entry,
      new Date(NOW.getTime() - 1 * 3_600_000), // window starts after the data stops
      WINDOW_END,
      { earliestAvailable: null, latestAvailable: stoppedTwoHoursAgo },
      NOW,
    );
    assert.deepEqual(plan, { action: 'give-up' });
  });

  it('the grace boundary: ended only when the data stopped MORE than 24 h ago', () => {
    const start = new Date(NOW.getTime() - 10 * 3_600_000);
    const at = (msAgo: number) => ({
      earliestAvailable: null,
      latestAvailable: new Date(NOW.getTime() - msAgo),
    });
    // the two predicates must agree at every point near the boundary
    for (const msAgo of [EPHEMERIS_ENDED_GRACE_MS - 1, EPHEMERIS_ENDED_GRACE_MS, EPHEMERIS_ENDED_GRACE_MS + 1]) {
      const bounds = at(msAgo);
      const plan = planCoverageRetry(entry, start, WINDOW_END, bounds, NOW);
      assert.equal(plan.action === 'ended', isEphemerisEndedInPast(bounds, NOW), `msAgo=${msAgo}`);
    }
    assert.equal(planCoverageRetry(entry, start, WINDOW_END, at(EPHEMERIS_ENDED_GRACE_MS + 1), NOW).action, 'ended');
    assert.equal(planCoverageRetry(entry, start, WINDOW_END, at(EPHEMERIS_ENDED_GRACE_MS), NOW).action, 'give-up');
  });

  it('gives up when the data has not started yet (not ended)', () => {
    const plan = planCoverageRetry(
      entry,
      WINDOW_START,
      new Date('2026-04-05T00:00:00Z'),
      { earliestAvailable: new Date('2026-04-06T00:00:00Z'), latestAvailable: null },
      NOW,
    );
    assert.deepEqual(plan, { action: 'give-up' });
  });

  it('gives up when the bounds change nothing', () => {
    const plan = planCoverageRetry(
      entry,
      WINDOW_START,
      WINDOW_END,
      { earliestAvailable: new Date('2026-03-01T00:00:00Z'), latestAvailable: new Date('2027-01-01T00:00:00Z') },
      NOW,
    );
    assert.deepEqual(plan, { action: 'give-up' });
  });
});

describe('requestWithCoverageClamp', () => {
  let warn: ReturnType<typeof mock.method>;
  beforeEach(() => {
    warn = mock.method(console, 'warn', () => {});
  });
  afterEach(() => mock.restoreAll());

  it('production case: wrong at both ends -> 3 requests, the last one succeeds and flags the end', async () => {
    const fake = fakeHorizons(new Date('2026-04-02T01:58:32.305Z'), new Date('2026-04-10T23:54:22.857Z'));
    const result = await requestWithCoverageClamp(entry, WINDOW_START, WINDOW_END, fake.request, NOW);

    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls[0].start.toISOString(), WINDOW_START.toISOString());
    assert.equal(fake.calls[1].start.toISOString(), '2026-04-02T02:08:32.305Z');
    assert.equal(fake.calls[1].end.toISOString(), WINDOW_END.toISOString());
    assert.equal(fake.calls[2].start.toISOString(), '2026-04-02T02:08:32.305Z');
    assert.equal(fake.calls[2].end.toISOString(), '2026-04-10T23:44:22.857Z');
    assert.equal(result.coverageEndedAt, '2026-04-10T23:54:22.857Z');
    assert.equal(warn.mock.callCount(), 2, 'one WARN per clamp retry, as before');
  });

  it('only the end is wrong -> one clamp, success, ended flag set', async () => {
    const fake = fakeHorizons(new Date('2026-03-01T00:00:00Z'), new Date('2026-04-10T23:54:22.857Z'));
    const result = await requestWithCoverageClamp(entry, WINDOW_START, WINDOW_END, fake.request, NOW);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].end.toISOString(), '2026-04-10T23:44:22.857Z');
    assert.equal(result.coverageEndedAt, '2026-04-10T23:54:22.857Z');
  });

  it('a live mission whose data ends a few hours ago is clamped but NOT flagged ended', async () => {
    const request: HorizonsRequestFn = async (_e, _start, end) => {
      // data ends 2026-10-13 15:00:00; the request reaches 6 hours past now
      if (end.getTime() > Date.parse('2026-10-13T15:00:00Z')) {
        throw new HorizonsObjectNotFoundError(
          'No ephemeris for target "X" after A.D. 2026-OCT-13 15:00:00.0000 TDB',
        );
      }
      return okResult();
    };
    const result = await requestWithCoverageClamp(entry, WINDOW_START, WINDOW_END, request, NOW);
    assert.equal(result.coverageEndedAt, undefined);
  });

  it('no clamp needed -> one request, no flag', async () => {
    const fake = fakeHorizons(new Date('2026-03-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'));
    const result = await requestWithCoverageClamp(entry, WINDOW_START, WINDOW_END, fake.request, NOW);
    assert.equal(fake.calls.length, 1);
    assert.equal(result.coverageEndedAt, undefined);
  });

  it('empty intersection (data ended before the window starts) -> DsoEphemerisEndedError, one request', async () => {
    const fake = fakeHorizons(new Date('2026-04-02T01:58:32.305Z'), new Date('2026-04-10T23:54:22.857Z'));
    const lateStart = new Date('2026-06-01T00:00:00Z');
    await assert.rejects(
      requestWithCoverageClamp(entry, lateStart, WINDOW_END, fake.request, NOW),
      (error: unknown) => {
        assert.ok(error instanceof DsoEphemerisEndedError);
        assert.equal(error.endedAt.toISOString(), '2026-04-10T23:54:22.857Z');
        assert.match(error.message, /ended 2026-04-10T23:54:22.857Z/);
        return true;
      },
    );
    assert.equal(fake.calls.length, 1);
  });

  it('data ended in the past but the clamped fetch still fails -> DsoEphemerisEndedError', async () => {
    const calls: number[] = [];
    const request: HorizonsRequestFn = async (_e, start) => {
      calls.push(start.getTime());
      if (calls.length === 1) throw new HorizonsObjectNotFoundError(PROD_AFTER_MESSAGE);
      throw new HorizonsObjectNotFoundError('Cannot interpret date. Please check format.');
    };
    // second error has no bound: that is a different failure, so it stays a plain error
    await assert.rejects(
      requestWithCoverageClamp(entry, WINDOW_START, WINDOW_END, request, NOW),
      (error: unknown) => error instanceof HorizonsObjectNotFoundError && !(error instanceof DsoEphemerisEndedError),
    );
    assert.equal(calls.length, 2);

    // but when the second error repeats a coverage bound and no new window exists, it is ended
    let n = 0;
    const repeating: HorizonsRequestFn = async () => {
      n += 1;
      throw new HorizonsObjectNotFoundError(PROD_AFTER_MESSAGE);
    };
    await assert.rejects(
      requestWithCoverageClamp(entry, WINDOW_START, WINDOW_END, repeating, NOW),
      DsoEphemerisEndedError,
    );
    assert.equal(n, 2, 'one clamp retry, then the same bound again -> stop');
  });

  it('data that stopped 2 hours ago and a window starting after it -> plain error, not ended (grace)', async () => {
    // NOW is 2026-10-13 18:19:30; the data stopped at 16:19:30, two hours before
    let calls = 0;
    const request: HorizonsRequestFn = async () => {
      calls += 1;
      throw new HorizonsObjectNotFoundError(
        'No ephemeris for target "X" after A.D. 2026-OCT-13 16:19:30.0000 TDB',
      );
    };
    const lateStart = new Date(NOW.getTime() - 1 * 3_600_000);
    await assert.rejects(
      requestWithCoverageClamp(entry, lateStart, WINDOW_END, request, NOW),
      (error: unknown) => error instanceof HorizonsObjectNotFoundError && !(error instanceof DsoEphemerisEndedError),
    );
    assert.equal(calls, 1);
  });

  it('data not started yet -> plain not-found error, never marked ended', async () => {
    const early = new Date('2026-04-05T00:00:00Z');
    const calls: Date[] = [];
    const request: HorizonsRequestFn = async (_e, start) => {
      calls.push(start);
      throw new HorizonsObjectNotFoundError(
        'No ephemeris for target "X" prior to A.D. 2026-DEC-01 00:00:00.0000 TDB',
      );
    };
    await assert.rejects(
      requestWithCoverageClamp(entry, WINDOW_START, early, request, NOW),
      (error: unknown) => {
        assert.ok(error instanceof HorizonsObjectNotFoundError);
        assert.ok(!(error instanceof DsoEphemerisEndedError));
        assert.match((error as Error).message, /no valid clamped retry window/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it('never makes more than 3 requests, even if every error brings a new bound', async () => {
    let n = 0;
    const request: HorizonsRequestFn = async () => {
      n += 1;
      const day = String(1 + n).padStart(2, '0');
      throw new HorizonsObjectNotFoundError(
        `No ephemeris for target "X" prior to A.D. 2026-NOV-${day} 00:00:00.0000 TDB`,
      );
    };
    await assert.rejects(
      requestWithCoverageClamp(entry, WINDOW_START, new Date('2027-06-01T00:00:00Z'), request, NOW),
      HorizonsObjectNotFoundError,
    );
    assert.equal(n, 3);
  });

  it('does not repeat a window that was already tried', async () => {
    const calls: number[] = [];
    // The bound is older than the window start, so the clamp cannot change anything.
    const request: HorizonsRequestFn = async (_e, start) => {
      calls.push(start.getTime());
      throw new HorizonsObjectNotFoundError(PRIOR_MESSAGE);
    };
    await assert.rejects(
      requestWithCoverageClamp(entry, new Date('2026-04-03T00:00:00Z'), WINDOW_END, request, NOW),
      HorizonsObjectNotFoundError,
    );
    assert.equal(calls.length, 1);
  });

  it('errors with no coverage bound keep the old message and make no retry', async () => {
    let n = 0;
    const request: HorizonsRequestFn = async () => {
      n += 1;
      throw new HorizonsObjectNotFoundError('No matches found for target "Artemis"');
    };
    await assert.rejects(
      requestWithCoverageClamp(entry, WINDOW_START, WINDOW_END, request, NOW),
      /No matches found.*requestedWindow=.*no valid clamped retry window/,
    );
    assert.equal(n, 1);
  });

  it('network and throttle errors pass through untouched', async () => {
    for (const err of [new HorizonsNetworkError('Horizons request failed (network/timeout)'), new HorizonsThrottleError('busy')]) {
      let n = 0;
      const request: HorizonsRequestFn = async () => {
        n += 1;
        throw err;
      };
      await assert.rejects(requestWithCoverageClamp(entry, WINDOW_START, WINDOW_END, request, NOW), (e) => e === err);
      assert.equal(n, 1);
    }
  });
});
