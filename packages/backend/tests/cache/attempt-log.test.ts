// Space-Track attempt log: the policy is pure (injected clock); the file layer
// is checked against a real temp dir. No network, no credentials.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { CRON_MIN_AGE_MS } from '../../src/cache/file-cache.js';
import {
  DAILY_ATTEMPT_CAP,
  FAILURE_BACKOFF_CAP_MS,
  SUCCESS_MIN_GAP_MS,
  attemptLogPath,
  attemptsOnDay,
  beginSpaceTrackAttempt,
  checkSpaceTrackGate,
  dailyFailureAlertDue,
  describeSkippedAttempt,
  evaluateGate,
  failureBackoffMs,
  markDailyAlertSent,
  nextUtcMidnight,
  parseAttemptState,
  utcDay,
  readAttemptState,
  recordSpaceTrackFailure,
  recordSpaceTrackSuccess,
  stateOnFailure,
  stateOnStart,
  stateOnSuccess,
  writeAttemptState,
  type AttemptState,
} from '../../src/cache/attempt-log.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-14T02:00:00.000Z');

function failed(count: number, at: number): AttemptState {
  return { lastAttemptAt: new Date(at).toISOString(), lastOutcome: 'failure', consecutiveFailures: count };
}

describe('failureBackoffMs', () => {
  it('grows 15 min, 30 min, 1 h, 2 h, 4 h, then caps at 6 h', () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 50, 1000].map((n) => failureBackoffMs(n) / MIN);
    assert.deepEqual(minutes, [15, 30, 60, 120, 240, 360, 360, 360, 360, 360]);
    assert.equal(FAILURE_BACKOFF_CAP_MS, 6 * HOUR);
  });

  it('treats 0 or a negative count as one failure', () => {
    assert.equal(failureBackoffMs(0), 15 * MIN);
    assert.equal(failureBackoffMs(-4), 15 * MIN);
  });

  it('the cap is far below the daily cron interval', () => {
    assert.ok(FAILURE_BACKOFF_CAP_MS < 24 * HOUR);
  });
});

describe('evaluateGate — pure policy', () => {
  it('the first attempt is allowed (no log)', () => {
    assert.deepEqual(evaluateGate(null, T0), { allowed: true });
  });

  it('after one failure, waits 15 minutes', () => {
    const state = failed(1, T0);
    const early = evaluateGate(state, T0 + 15 * MIN - 1);
    assert.equal(early.allowed, false);
    if (!early.allowed) {
      assert.equal(early.retryAt, T0 + 15 * MIN);
      assert.equal(early.reason, 'backoff');
      assert.equal(early.consecutiveFailures, 1);
    }
    assert.deepEqual(evaluateGate(state, T0 + 15 * MIN), { allowed: true });
  });

  it('backoff follows the failure count and stops at 6 hours', () => {
    for (const [count, waitMin] of [[2, 30], [3, 60], [4, 120], [5, 240], [6, 360], [12, 360]] as const) {
      const state = failed(count, T0);
      assert.equal(evaluateGate(state, T0 + waitMin * MIN - 1).allowed, false, `count ${count} blocked`);
      assert.equal(evaluateGate(state, T0 + waitMin * MIN).allowed, true, `count ${count} open`);
    }
  });

  it('after a success, waits one hour (the same value as the cron cache guard)', () => {
    assert.equal(SUCCESS_MIN_GAP_MS, CRON_MIN_AGE_MS);
    const state = stateOnSuccess(T0);
    const early = evaluateGate(state, T0 + HOUR - 1);
    assert.equal(early.allowed, false);
    if (!early.allowed) assert.equal(early.reason, 'recent-success');
    assert.equal(evaluateGate(state, T0 + HOUR).allowed, true);
  });

  it('a pending attempt that never finished counts as a failure', () => {
    const started = stateOnStart(null, T0);
    assert.equal(started.lastOutcome, 'started');
    assert.equal(started.consecutiveFailures, 1);
    assert.equal(evaluateGate(started, T0 + 14 * MIN).allowed, false);
    assert.equal(evaluateGate(started, T0 + 15 * MIN).allowed, true);
  });

  it('a stamp in the future cannot block for longer than one wait', () => {
    const skewed = failed(1, T0 + 10 * 24 * HOUR);
    const d = evaluateGate(skewed, T0);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.retryAt, T0 + 15 * MIN);
    const skewedSuccess = { ...stateOnSuccess(T0 + 10 * 24 * HOUR) };
    const s = evaluateGate(skewedSuccess, T0);
    assert.equal(s.allowed, false);
    if (!s.allowed) assert.equal(s.retryAt, T0 + HOUR);
  });

  it('an unparseable timestamp is allowed', () => {
    assert.deepEqual(
      evaluateGate({ lastAttemptAt: 'not a date', lastOutcome: 'failure', consecutiveFailures: 3 }, T0),
      { allowed: true },
    );
  });
});

describe('transitions', () => {
  it('failures accumulate across attempts and a success resets them', () => {
    let state: AttemptState | null = null;
    for (let i = 1; i <= 4; i++) {
      const started = stateOnStart(state, T0 + i * HOUR);
      assert.equal(started.consecutiveFailures, i);
      state = stateOnFailure(started, T0 + i * HOUR + MIN);
      assert.equal(state.consecutiveFailures, i, 'finishing a failed attempt does not count it twice');
      assert.equal(state.lastOutcome, 'failure');
    }
    state = stateOnSuccess(T0 + 10 * HOUR);
    assert.deepEqual(state, {
      lastAttemptAt: new Date(T0 + 10 * HOUR).toISOString(),
      lastOutcome: 'success',
      consecutiveFailures: 0,
    });
    assert.equal(stateOnStart(state, T0 + 20 * HOUR).consecutiveFailures, 1, 'a new attempt after a success starts at 1');
  });
});

describe('parseAttemptState', () => {
  it('accepts a valid record', () => {
    const ok = { lastAttemptAt: '2026-10-14T02:00:00.000Z', lastOutcome: 'success', consecutiveFailures: 0 };
    assert.deepEqual(parseAttemptState(ok), ok);
  });

  it('rejects anything else', () => {
    const bad: unknown[] = [
      null,
      'text',
      42,
      [],
      {},
      { lastAttemptAt: 'x', lastOutcome: 'success', consecutiveFailures: 0 },
      { lastAttemptAt: '2026-10-14T02:00:00Z', lastOutcome: 'maybe', consecutiveFailures: 0 },
      { lastAttemptAt: '2026-10-14T02:00:00Z', lastOutcome: 'failure', consecutiveFailures: -1 },
      { lastAttemptAt: '2026-10-14T02:00:00Z', lastOutcome: 'failure', consecutiveFailures: 1.5 },
      { lastAttemptAt: '2026-10-14T02:00:00Z', lastOutcome: 'failure', consecutiveFailures: '2' },
    ];
    for (const value of bad) assert.equal(parseAttemptState(value), null, JSON.stringify(value));
  });
});

describe('describeSkippedAttempt', () => {
  it('says when the next attempt is allowed', () => {
    const d = evaluateGate(failed(2, T0), T0 + 5 * MIN);
    assert.equal(d.allowed, false);
    if (d.allowed) return;
    const line = describeSkippedAttempt(d, T0 + 5 * MIN);
    assert.match(line, /Space-Track attempt skipped/);
    assert.match(line, /2 failed attempts/);
    assert.ok(line.includes(new Date(T0 + 30 * MIN).toISOString()), line);
    assert.match(line, /in about 25 min/);
  });
});

describe('attempt log file — real temp dir', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let warn: ReturnType<typeof mock.method>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-log-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    warn = mock.method(console, 'warn', () => {});
  });

  afterEach(() => {
    mock.restoreAll();
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lives next to the cache', () => {
    assert.equal(attemptLogPath(), path.join(tmpDir, 'spacetrack-attempts.json'));
  });

  it('a missing file means allowed, with no warning', () => {
    assert.equal(readAttemptState(), null);
    assert.deepEqual(checkSpaceTrackGate(T0), { allowed: true });
    assert.equal(warn.mock.callCount(), 0);
  });

  it('a corrupt file means allowed, with one warning', () => {
    fs.writeFileSync(attemptLogPath(), '{ this is not json', 'utf8');
    assert.equal(readAttemptState(), null);
    assert.deepEqual(checkSpaceTrackGate(T0), { allowed: true });
    assert.ok(warn.mock.callCount() >= 1);
  });

  it('a file with the wrong shape means allowed, with a warning', () => {
    fs.writeFileSync(attemptLogPath(), JSON.stringify({ lastAttemptAt: 5 }), 'utf8');
    assert.equal(readAttemptState(), null);
    assert.equal(warn.mock.callCount(), 1);
  });

  it('writes atomically: valid JSON in place, no temp file left', () => {
    const state = stateOnSuccess(T0);
    writeAttemptState(state);
    assert.deepEqual(JSON.parse(fs.readFileSync(attemptLogPath(), 'utf8')), state);
    assert.deepEqual(fs.readdirSync(tmpDir), ['spacetrack-attempts.json']);
  });

  it('never touches other files in the cache dir', () => {
    const other = path.join(tmpDir, 'tle-cache.json');
    fs.writeFileSync(other, '[1,2,3]', 'utf8');
    const begun = beginSpaceTrackAttempt(T0);
    recordSpaceTrackFailure(begun, T0 + MIN);
    recordSpaceTrackSuccess(T0 + HOUR);
    assert.equal(fs.readFileSync(other, 'utf8'), '[1,2,3]');
    assert.deepEqual(fs.readdirSync(tmpDir).sort(), ['spacetrack-attempts.json', 'tle-cache.json']);
  });

  it('the pending record is on disk before the attempt finishes', () => {
    beginSpaceTrackAttempt(T0);
    assert.deepEqual(readAttemptState(), {
      lastAttemptAt: new Date(T0).toISOString(),
      lastOutcome: 'started',
      consecutiveFailures: 1,
      attemptDay: '2026-10-14',
      attemptsToday: 1,
    });
  });

  it('restart simulation: a new process reading the same file respects the wait', () => {
    // process 1: login starts, then fails
    const a = beginSpaceTrackAttempt(T0);
    recordSpaceTrackFailure(a, T0 + 2 * MIN);

    // process 2 (fresh reads, nothing in memory): restarts 1 minute later
    const second = checkSpaceTrackGate(T0 + 3 * MIN);
    assert.equal(second.allowed, false);
    if (!second.allowed) assert.equal(second.retryAt, T0 + 17 * MIN);

    // allowed again after the wait; a second failure doubles it
    assert.equal(checkSpaceTrackGate(T0 + 17 * MIN).allowed, true);
    const b = beginSpaceTrackAttempt(T0 + 17 * MIN);
    recordSpaceTrackFailure(b, T0 + 18 * MIN);
    const third = checkSpaceTrackGate(T0 + 20 * MIN);
    assert.equal(third.allowed, false);
    if (!third.allowed) {
      assert.equal(third.retryAt, T0 + 18 * MIN + 30 * MIN);
      assert.equal(third.consecutiveFailures, 2);
    }
  });

  it('a crash mid-attempt (never finished) still backs off after restart', () => {
    beginSpaceTrackAttempt(T0); // process dies here
    const d = checkSpaceTrackGate(T0 + 10 * 1000);
    assert.equal(d.allowed, false);
  });

  it('a success resets the counter on disk', () => {
    const a = beginSpaceTrackAttempt(T0);
    recordSpaceTrackFailure(a, T0 + MIN);
    const b = beginSpaceTrackAttempt(T0 + HOUR);
    recordSpaceTrackSuccess(T0 + HOUR + MIN, b);
    assert.equal(b.started.consecutiveFailures, 2);
    // the failure counter is reset; the day's count of 2 attempts and the success stay
    assert.deepEqual(readAttemptState(), {
      ...stateOnSuccess(T0 + HOUR + MIN),
      attemptDay: '2026-10-14',
      attemptsToday: 2,
      successToday: true,
    });
  });

  it('an unwritable log only warns: the functions still return', () => {
    // A directory where the file should be makes both the read and the rename fail.
    fs.mkdirSync(attemptLogPath());
    assert.equal(readAttemptState(), null);
    assert.deepEqual(checkSpaceTrackGate(T0), { allowed: true });
    const begun = beginSpaceTrackAttempt(T0);
    recordSpaceTrackFailure(begun, T0 + MIN);
    recordSpaceTrackSuccess(T0 + 2 * MIN);
    assert.ok(warn.mock.callCount() >= 1);
  });
});

// ------------------------------------------------------------
// Daily cap (5 per UTC day) and the alert memory
// ------------------------------------------------------------

/** Run `n` failed attempts, one hour apart from `start`. Returns the last record and the time after it. */
function failTimes(n: number, start: number, from: AttemptState | null = null): { state: AttemptState; end: number } {
  let state = from;
  let t = start;
  for (let i = 0; i < n; i++) {
    const started = stateOnStart(state, t);
    state = stateOnFailure(started, t + MIN);
    t += HOUR;
  }
  return { state: state as AttemptState, end: t };
}

describe('daily cap', () => {
  it('the cap is 5 and the first four attempts are not capped', () => {
    assert.equal(DAILY_ATTEMPT_CAP, 5);
    const four = failTimes(4, T0 - HOUR);
    assert.equal(four.state.attemptsToday, 4);
    // 4 failures in a row wait 2 h; after that the gate is open, no cap in sight
    assert.deepEqual(evaluateGate(four.state, T0 + 5 * HOUR), { allowed: true });
  });

  it('the 5th attempt reaches the cap: not allowed until the next 00:00 UTC', () => {
    const five = failTimes(5, T0 - HOUR); // attempts at 01:00 .. 05:00 on 2026-10-14
    assert.equal(five.state.attemptsToday, 5);
    const now = T0 + 8 * HOUR; // 10:00, far past the 6 h backoff
    const d = evaluateGate(five.state, now);
    assert.equal(d.allowed, false);
    if (!d.allowed) {
      assert.equal(d.reason, 'daily-cap');
      assert.equal(d.retryAt, Date.parse('2026-10-15T00:00:00.000Z'));
    }
  });

  it('a success counts toward the cap too', () => {
    let state: AttemptState | null = null;
    for (let i = 0; i < 4; i++) state = stateOnFailure(stateOnStart(state, T0 + i * HOUR), T0 + i * HOUR + MIN);
    const fifth = stateOnStart(state, T0 + 4 * HOUR);
    const done = stateOnSuccess(T0 + 4 * HOUR + MIN, fifth);
    assert.equal(done.attemptsToday, 5);
    assert.equal(done.successToday, true);
    const d = evaluateGate(done, T0 + 7 * HOUR);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, 'daily-cap');
  });

  it('resets at UTC midnight, to the second', () => {
    const five = failTimes(5, T0 - HOUR);
    const midnight = Date.parse('2026-10-15T00:00:00.000Z');
    assert.equal(evaluateGate(five.state, midnight - 1).allowed, false);
    assert.deepEqual(evaluateGate(five.state, midnight), { allowed: true });
    // and the new day counts from 1 again
    const next = stateOnStart(five.state, midnight);
    assert.equal(next.attemptDay, '2026-10-15');
    assert.equal(next.attemptsToday, 1);
  });

  it('a capped day leaves no backoff behind: the 02:00 cron of the new day is allowed', () => {
    // attempts at 19:00 .. 23:00, the 5th fails at 23:01: a 4 h backoff would run to 03:01 and block 02:00
    const five = failTimes(5, Date.parse('2026-10-14T19:00:00.000Z'));
    assert.equal(five.state.attemptDay, '2026-10-14');
    assert.equal(five.state.attemptsToday, 5);
    assert.equal(evaluateGate(five.state, Date.parse('2026-10-14T23:30:00.000Z')).allowed, false);
    const cron = Date.parse('2026-10-15T02:00:00.000Z');
    assert.deepEqual(evaluateGate(five.state, cron), { allowed: true });
  });

  it('an attempt that straddles midnight is counted on the day it started', () => {
    const started = stateOnStart(null, Date.parse('2026-10-14T23:59:59.000Z'));
    const failedAfterMidnight = stateOnFailure(started, Date.parse('2026-10-15T00:00:30.000Z'));
    assert.equal(failedAfterMidnight.attemptDay, '2026-10-14');
    assert.equal(attemptsOnDay(failedAfterMidnight, Date.parse('2026-10-15T00:01:00.000Z')), 0);
  });

  it('an old-format file (no daily fields) counts as 0 attempts and still gates normally', () => {
    const old = { lastAttemptAt: new Date(T0).toISOString(), lastOutcome: 'failure', consecutiveFailures: 1 };
    const parsed = parseAttemptState(old);
    assert.deepEqual(parsed, old);
    assert.equal(attemptsOnDay(parsed, T0 + MIN), 0);
    assert.equal(evaluateGate(parsed, T0 + MIN).allowed, false); // the 15 min backoff
    assert.deepEqual(evaluateGate(parsed, T0 + 15 * MIN), { allowed: true });
    const next = stateOnStart(parsed, T0 + 15 * MIN);
    assert.equal(next.attemptsToday, 1);
    assert.equal(next.consecutiveFailures, 2);
  });

  it('bad daily fields are dropped, not fatal', () => {
    const odd = {
      lastAttemptAt: new Date(T0).toISOString(),
      lastOutcome: 'failure',
      consecutiveFailures: 1,
      attemptDay: 'yesterday',
      attemptsToday: 'many',
      alertSentDay: 42,
    };
    assert.deepEqual(parseAttemptState(odd), {
      lastAttemptAt: odd.lastAttemptAt,
      lastOutcome: 'failure',
      consecutiveFailures: 1,
    });
    const halfBad = { ...odd, attemptDay: '2026-10-14', attemptsToday: -2 };
    assert.equal(parseAttemptState(halfBad)?.attemptsToday, 0);
  });

  it('clock skew: a count stamped with a future day never blocks', () => {
    const skewed: AttemptState = {
      lastAttemptAt: new Date(T0 - HOUR).toISOString(),
      lastOutcome: 'failure',
      consecutiveFailures: 1,
      attemptDay: '2027-01-01',
      attemptsToday: 5,
    };
    assert.equal(attemptsOnDay(skewed, T0), 0);
    assert.deepEqual(evaluateGate(skewed, T0), { allowed: true });
    // the next attempt starts the real day at 1
    assert.equal(stateOnStart(skewed, T0).attemptsToday, 1);
  });

  it('clock skew: the clock jumps back inside the capped day, the cap still holds until midnight', () => {
    const five = failTimes(5, T0 - HOUR).state;
    const d = evaluateGate(five, T0 - 30 * MIN);
    assert.equal(d.allowed, false);
    if (!d.allowed) {
      assert.equal(d.reason, 'daily-cap');
      assert.equal(d.retryAt, Date.parse('2026-10-15T00:00:00.000Z'));
    }
  });

  it('nextUtcMidnight is always within 24 h (far below the setTimeout limit)', () => {
    for (const t of [T0, Date.parse('2026-10-14T00:00:00.000Z'), Date.parse('2026-10-14T23:59:59.999Z')]) {
      const next = nextUtcMidnight(t);
      assert.ok(next > t && next - t <= 24 * HOUR);
      assert.equal(new Date(next).toISOString().slice(11), '00:00:00.000Z');
    }
    assert.equal(utcDay(Date.parse('2026-10-14T23:59:59.999Z')), '2026-10-14');
  });

  it('describeSkippedAttempt names the daily limit', () => {
    const five = failTimes(5, T0 - HOUR).state;
    const now = T0 + 8 * HOUR;
    const d = evaluateGate(five, now);
    assert.equal(d.allowed, false);
    if (d.allowed) return;
    const line = describeSkippedAttempt(d, now);
    assert.match(line, /daily limit of 5/);
    assert.ok(line.includes('2026-10-15T00:00:00.000Z'), line);
  });
});

describe('dailyFailureAlertDue', () => {
  it('is due only on the 5th failure of a day with no success', () => {
    const four = failTimes(4, T0 - HOUR).state;
    assert.equal(dailyFailureAlertDue(four), false, '4th failure');
    const five = failTimes(1, T0 + 4 * HOUR, four).state;
    assert.equal(five.attemptsToday, 5);
    assert.equal(dailyFailureAlertDue(five), true, '5th failure');
  });

  it('is not due when one attempt of the day succeeded', () => {
    let state: AttemptState | null = null;
    state = stateOnSuccess(T0 + MIN, stateOnStart(state, T0));
    for (let i = 1; i <= 4; i++) state = stateOnFailure(stateOnStart(state, T0 + i * HOUR), T0 + i * HOUR + MIN);
    assert.equal(state.attemptsToday, 5);
    assert.equal(dailyFailureAlertDue(state), false);
  });

  it('is not due again once the day is marked', () => {
    const five = failTimes(5, T0 - HOUR).state;
    assert.equal(dailyFailureAlertDue(five), true);
    assert.equal(dailyFailureAlertDue({ ...five, alertSentDay: five.attemptDay }), false);
    // a later failure record of the same day keeps the memory
    assert.equal(stateOnStart({ ...five, alertSentDay: five.attemptDay }, T0 + 6 * HOUR).alertSentDay, five.attemptDay);
  });

  it('is not due for an old-format record, a pending attempt, or no record', () => {
    assert.equal(dailyFailureAlertDue(null), false);
    assert.equal(dailyFailureAlertDue(failed(9, T0)), false);
    assert.equal(dailyFailureAlertDue(stateOnStart(failTimes(4, T0 - HOUR).state, T0 + 4 * HOUR)), false);
  });

  it('the day marker is written to the file and survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-alert-test-'));
    const prev = process.env.CACHE_DIR;
    process.env.CACHE_DIR = dir;
    try {
      const five = failTimes(5, T0 - HOUR).state;
      markDailyAlertSent(five);
      const reread = readAttemptState();
      assert.equal(reread?.alertSentDay, '2026-10-14');
      assert.equal(dailyFailureAlertDue(reread), false);
      // a new UTC day: the next day's 5th failure may alert again
      const nextDay = failTimes(5, Date.parse('2026-10-15T01:00:00.000Z'), reread).state;
      assert.equal(nextDay.attemptsToday, 5);
      assert.equal(dailyFailureAlertDue(nextDay), true);
    } finally {
      if (prev === undefined) delete process.env.CACHE_DIR;
      else process.env.CACHE_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
