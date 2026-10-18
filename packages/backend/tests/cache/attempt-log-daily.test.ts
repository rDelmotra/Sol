// The Space-Track backoff is computed per UTC day (15 min, 30 min, 1 h, 2 h between the
// 5 attempts of a day), and the alert streak ("day N in a row") is remembered in the log.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import {
  attemptLogPath,
  evaluateGate,
  failureBackoffMs,
  failuresForBackoff,
  markDailyAlertSent,
  parseAttemptState,
  readAttemptState,
  stateOnFailure,
  stateOnStart,
  stateOnSuccess,
  type AttemptState,
} from '../../src/cache/attempt-log.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-14T02:00:00.000Z');

function failed(count: number, at: number): AttemptState {
  return { lastAttemptAt: new Date(at).toISOString(), lastOutcome: 'failure', consecutiveFailures: count };
}

describe('backoff resets each UTC day', () => {
  it("the wait before attempt N+1 of a day depends on that day's failures, not on a multi-day streak", () => {
    // 9 failures in a row from earlier days, then the first failure of today
    const streak: AttemptState = {
      lastAttemptAt: '2026-10-13T20:00:00.000Z',
      lastOutcome: 'failure',
      consecutiveFailures: 9,
      attemptDay: '2026-10-13',
      attemptsToday: 5,
    };
    const first = stateOnFailure(
      stateOnStart(streak, Date.parse('2026-10-14T00:00:10.000Z')),
      Date.parse('2026-10-14T00:00:11.000Z'),
    );
    assert.equal(first.consecutiveFailures, 10, 'the streak still counts, for information');
    assert.equal(first.attemptsToday, 1);
    const now = Date.parse('2026-10-14T00:05:00.000Z');
    assert.equal(failuresForBackoff(first, now), 1);
    const d = evaluateGate(first, now);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.retryAt, Date.parse('2026-10-14T00:15:11.000Z'), '15 minutes, not 6 hours');
  });

  it('waits between attempts 1-2, 2-3, 3-4, 4-5 of a day are 15 min, 30 min, 1 h, 2 h; the 5th is 3 h 45 min after the 1st', () => {
    let state: AttemptState | null = null;
    let t = Date.parse('2026-10-14T00:00:00.000Z');
    const starts: number[] = [];
    for (let i = 1; i <= 5; i++) {
      starts.push(t);
      state = stateOnFailure(stateOnStart(state, t), t);
      const d = evaluateGate(state, t);
      assert.equal(d.allowed, false);
      if (d.allowed) continue;
      if (i < 5) {
        assert.equal(d.reason, 'backoff');
        t = d.retryAt;
        assert.equal(evaluateGate(state, t).allowed, true);
      } else {
        assert.equal(d.reason, 'daily-cap');
      }
    }
    assert.deepEqual(
      starts.slice(1).map((v, i) => (v - starts[i]) / MIN),
      [15, 30, 60, 120],
    );
    assert.equal((starts[4] - starts[0]) / MIN, 225);
  });

  it('a day that ended in failures leaves no wait: the first attempt after 00:00 UTC is allowed at once', () => {
    let state: AttemptState | null = null;
    for (let i = 0; i < 3; i++) {
      state = stateOnFailure(stateOnStart(state, Date.parse('2026-10-14T23:00:00.000Z') + i * HOUR / 4), T0);
    }
    const nearMidnight: AttemptState = { ...(state as AttemptState), lastAttemptAt: '2026-10-14T23:58:00.000Z' };
    assert.equal(evaluateGate(nearMidnight, Date.parse('2026-10-14T23:59:00.000Z')).allowed, false);
    assert.deepEqual(evaluateGate(nearMidnight, Date.parse('2026-10-15T00:00:01.000Z')), { allowed: true });
    const next = stateOnStart(nearMidnight, Date.parse('2026-10-15T00:00:01.000Z'));
    assert.equal(next.attemptsToday, 1);
    assert.equal(next.attemptDay, '2026-10-15');
  });

  it('after a success the 1 hour gap still applies, also across midnight', () => {
    const ok = stateOnSuccess(Date.parse('2026-10-14T23:30:00.000Z'));
    const d = evaluateGate(ok, Date.parse('2026-10-15T00:10:00.000Z'));
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, 'recent-success');
  });

  it("failures after a success on the same day count from that success", () => {
    const day = '2026-10-14';
    let state = stateOnSuccess(Date.parse(`${day}T00:30:00.000Z`), stateOnStart(null, Date.parse(`${day}T00:29:00.000Z`)));
    state = stateOnFailure(stateOnStart(state, Date.parse(`${day}T02:00:00.000Z`)), Date.parse(`${day}T02:00:00.000Z`));
    assert.equal(state.attemptsToday, 2);
    assert.equal(state.consecutiveFailures, 1);
    assert.equal(failuresForBackoff(state, Date.parse(`${day}T02:01:00.000Z`)), 1);
  });

  it('an old-format file (no attemptDay) still uses its failure count, so a deploy does not forget a wait', () => {
    assert.equal(failuresForBackoff(failed(3, T0), T0), 3);
    assert.equal(failuresForBackoff(failed(0, T0), T0), 1);
    assert.equal(evaluateGate(failed(3, T0), T0 + 59 * MIN).allowed, false);
    assert.deepEqual(evaluateGate(failed(3, T0), T0 + 60 * MIN), { allowed: true });
  });

  it('a future-dated record never blocks (clock skew)', () => {
    const skewed: AttemptState = {
      lastAttemptAt: new Date(T0 + 3 * HOUR).toISOString(),
      lastOutcome: 'failure',
      consecutiveFailures: 4,
      attemptDay: '2026-10-20',
      attemptsToday: 4,
    };
    assert.deepEqual(evaluateGate(skewed, T0), { allowed: true });
  });

  it('the backoff table keeps its cap', () => {
    assert.equal(failureBackoffMs(50), 6 * HOUR);
  });
});

describe('alert streak (days in a row)', () => {
  const day = (d: string, n = 5) => ({
    lastAttemptAt: `${d}T03:45:00.000Z`,
    lastOutcome: 'failure' as const,
    consecutiveFailures: 20,
    attemptDay: d,
    attemptsToday: n,
  });
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-streak-test-'));
    prev = process.env.CACHE_DIR;
    process.env.CACHE_DIR = dir;
    mock.method(console, 'warn', () => {});
  });

  afterEach(() => {
    mock.restoreAll();
    if (prev === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts at 1, goes up on consecutive days, and starts again after a gap', () => {
    const d1 = markDailyAlertSent(day('2026-10-14'));
    assert.equal(d1.alertSentDay, '2026-10-14');
    assert.equal(d1.alertStreakDays, 1);

    // the next day's attempts carry the memory forward
    const started = stateOnStart(d1, Date.parse('2026-10-15T00:00:10.000Z'));
    assert.equal(started.alertStreakDays, 1);
    assert.equal(started.alertSentDay, '2026-10-14');
    const d2 = markDailyAlertSent({ ...started, ...day('2026-10-15') });
    assert.equal(d2.alertStreakDays, 2);
    assert.equal(readAttemptState()?.alertStreakDays, 2);

    const d3 = markDailyAlertSent({ ...d2, ...day('2026-10-16') });
    assert.equal(d3.alertStreakDays, 3);

    const afterGap = markDailyAlertSent({ ...d3, ...day('2026-10-18') });
    assert.equal(afterGap.alertStreakDays, 1);
  });

  it('a success drops the streak and keeps the day marker', () => {
    const d1 = markDailyAlertSent(day('2026-10-14'));
    const ok = stateOnSuccess(Date.parse('2026-10-15T01:00:00.000Z'), stateOnStart(d1, Date.parse('2026-10-15T00:59:00.000Z')));
    assert.equal(ok.alertStreakDays, undefined);
    assert.equal(ok.alertSentDay, '2026-10-14');
  });

  it('a record without a day is returned unchanged and nothing is written', () => {
    const old = failed(3, T0);
    assert.strictEqual(markDailyAlertSent(old), old);
    assert.equal(fs.existsSync(attemptLogPath()), false);
  });

  it('parseAttemptState keeps a valid streak and drops a bad one', () => {
    const base = { lastAttemptAt: '2026-10-14T02:00:00.000Z', lastOutcome: 'failure', consecutiveFailures: 1 };
    assert.equal(parseAttemptState({ ...base, alertSentDay: '2026-10-14', alertStreakDays: 3 })?.alertStreakDays, 3);
    assert.equal(parseAttemptState({ ...base, alertSentDay: '2026-10-14', alertStreakDays: 0 })?.alertStreakDays, undefined);
    assert.equal(parseAttemptState({ ...base, alertSentDay: '2026-10-14', alertStreakDays: 'x' })?.alertStreakDays, undefined);
    assert.equal(parseAttemptState({ ...base, alertStreakDays: 3 })?.alertStreakDays, undefined, 'no day, no streak');
  });
});
