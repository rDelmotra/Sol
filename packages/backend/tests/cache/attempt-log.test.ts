// Space-Track attempt log: the policy is pure (injected clock); the file layer
// is checked against a real temp dir. No network, no credentials.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { CRON_MIN_AGE_MS } from '../../src/cache/file-cache.js';
import {
  FAILURE_BACKOFF_CAP_MS,
  SUCCESS_MIN_GAP_MS,
  attemptLogPath,
  beginSpaceTrackAttempt,
  checkSpaceTrackGate,
  describeSkippedAttempt,
  evaluateGate,
  failureBackoffMs,
  parseAttemptState,
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
    recordSpaceTrackSuccess(T0 + HOUR + MIN);
    assert.equal(b.started.consecutiveFailures, 2);
    assert.deepEqual(readAttemptState(), stateOnSuccess(T0 + HOUR + MIN));
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
