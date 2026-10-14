// runUpdateCycle with the Space-Track attempt log. Every upstream is a fake
// (no network, no credentials); the cache dir is a real temp dir; the clock is injected.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { runUpdateCycle, type UpdateCycleDeps } from '../../src/cron/tle-updater.js';
import { cacheAgeMs, writeCache } from '../../src/cache/file-cache.js';
import {
  attemptLogPath,
  readAttemptState,
  stateOnFailure,
  stateOnStart,
  stateOnSuccess,
  writeAttemptState,
} from '../../src/cache/attempt-log.js';
import { celesTrakGp, spaceTrackGp } from './gp-fixtures.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Real "now" at test start: cache mtimes are real, so the fake clock starts here.
const T0 = Date.now();

describe('runUpdateCycle — Space-Track attempt log', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let lines: string[];
  let clock: number;
  let stCalls: number;
  let ctCalls: number;

  type Behaviour = 'ok' | 'fail';

  function deps(st: Behaviour, ct: Behaviour, over: Partial<UpdateCycleDeps> = {}): Partial<UpdateCycleDeps> {
    return {
      spaceTrackConfigured: () => true,
      now: () => clock,
      fetchSpaceTrack: async () => {
        stCalls++;
        if (st === 'fail') throw new Error('Space-Track login rejected (HTTP 500)');
        return { gp: spaceTrackGp(3) };
      },
      fetchCelesTrak: async () => {
        ctCalls++;
        if (ct === 'fail') throw new Error('CelesTrak fetch failed after 3 attempts');
        return celesTrakGp(3);
      },
      ...over,
    };
  }

  function pinCacheMtime(ms: number): void {
    const t = new Date(ms);
    fs.utimesSync(path.join(tmpDir, 'tle-cache.json'), t, t);
  }

  function hasCache(): boolean {
    return fs.existsSync(path.join(tmpDir, 'tle-cache.json'));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-cycle-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    lines = [];
    clock = T0;
    stCalls = 0;
    ctCalls = 0;
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });

  afterEach(() => {
    mock.restoreAll();
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('both sources down: a restart does not log in to Space-Track again', async () => {
    await runUpdateCycle('boot', deps('fail', 'fail'));
    assert.equal(stCalls, 1);
    assert.equal(ctCalls, 1);
    assert.equal(hasCache(), false);

    // container restarts 30 seconds later: new process, same volume
    clock = T0 + 30_000;
    await runUpdateCycle('boot', deps('fail', 'fail'));
    assert.equal(stCalls, 1, 'no second Space-Track login');
    assert.equal(ctCalls, 2, 'fallback still runs, exactly as before');

    const skipLines = lines.filter((l) => l.includes('Space-Track attempt skipped'));
    assert.equal(skipLines.length, 1, 'one INFO line');
    assert.ok(skipLines[0].includes('INFO'));
    assert.ok(skipLines[0].includes(new Date(T0 + 15 * MIN).toISOString()), skipLines[0]);
  });

  it('after the wait, Space-Track is tried again and the wait doubles', async () => {
    await runUpdateCycle('boot', deps('fail', 'fail'));
    clock = T0 + 15 * MIN;
    await runUpdateCycle('boot', deps('fail', 'fail'));
    assert.equal(stCalls, 2);
    assert.equal(readAttemptState()?.consecutiveFailures, 2);

    clock = T0 + 15 * MIN + 29 * MIN;
    await runUpdateCycle('boot', deps('fail', 'fail'));
    assert.equal(stCalls, 2, '30 minute wait not over');
    clock = T0 + 15 * MIN + 30 * MIN;
    await runUpdateCycle('boot', deps('fail', 'fail'));
    assert.equal(stCalls, 3);
  });

  it('while Space-Track is held back, CelesTrak still fills a missing cache', async () => {
    await runUpdateCycle('boot', deps('fail', 'fail'));
    clock = T0 + MIN;
    await runUpdateCycle('boot', deps('fail', 'ok'));
    assert.equal(stCalls, 1);
    assert.equal(hasCache(), true);
    assert.ok(lines.some((l) => l.includes('TLE update complete: 3 objects from celestrak')));
    // a CelesTrak success must not reset the Space-Track failure count
    assert.equal(readAttemptState()?.consecutiveFailures, 1);
  });

  it('a stale cache keeps serving when everything is held back or down', async () => {
    writeCache([]);
    pinCacheMtime(T0 - 30 * HOUR);
    const stale = fs.readFileSync(path.join(tmpDir, 'tle-cache.json'), 'utf8');
    writeAttemptState(stateOnFailure(stateOnStart(null, T0 - MIN), T0 - MIN));

    await runUpdateCycle('boot', deps('fail', 'fail'));
    assert.equal(stCalls, 0);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'tle-cache.json'), 'utf8'), stale);
    assert.ok(lines.some((l) => l.includes('continuing to serve stale cache')));
  });

  it('a success resets the counter and writes the cache', async () => {
    await runUpdateCycle('boot', deps('fail', 'fail'));
    clock = T0 + 15 * MIN;
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(stCalls, 2);
    assert.equal(hasCache(), true);
    assert.deepEqual(readAttemptState(), stateOnSuccess(T0 + 15 * MIN));
  });

  it('the daily cron still refreshes: cache 23h59m old, last success a day ago', async () => {
    writeCache([]);
    pinCacheMtime(T0 - (24 * HOUR - MIN));
    writeAttemptState(stateOnSuccess(T0 - 24 * HOUR));

    await runUpdateCycle('cron', deps('ok', 'fail'));
    assert.equal(stCalls, 1);
    assert.equal(ctCalls, 0);
    assert.deepEqual(readAttemptState(), stateOnSuccess(T0));
  });

  it('the daily cron is not blocked by old failures (6 h cap)', async () => {
    writeCache([]);
    pinCacheMtime(T0 - 25 * HOUR);
    // 20 failures in a row, the last one 7 hours ago: backoff is capped at 6 h
    writeAttemptState({
      lastAttemptAt: new Date(T0 - 7 * HOUR).toISOString(),
      lastOutcome: 'failure',
      consecutiveFailures: 20,
    });
    await runUpdateCycle('cron', deps('ok', 'fail'));
    assert.equal(stCalls, 1);
  });

  it('the 1 hour success gap and the cron cache guard agree', async () => {
    await runUpdateCycle('boot', deps('ok', 'fail'));
    pinCacheMtime(T0);
    assert.equal(stCalls, 1);

    // 59 minutes later the cache rule already skips the cron
    clock = T0 + 59 * MIN;
    await runUpdateCycle('cron', deps('ok', 'fail'));
    assert.equal(stCalls, 1);
    assert.ok(lines.some((l) => l.includes('Cache is fresh for cron')));

    // 61 minutes later both rules allow it
    clock = T0 + 61 * MIN;
    await runUpdateCycle('cron', deps('ok', 'fail'));
    assert.equal(stCalls, 2);
  });

  it('a recent success with the cache file gone holds Space-Track back and uses CelesTrak', async () => {
    writeAttemptState(stateOnSuccess(T0 - 10 * MIN));
    assert.equal(cacheAgeMs(), null);
    await runUpdateCycle('boot', deps('ok', 'ok'));
    assert.equal(stCalls, 0);
    assert.equal(ctCalls, 1);
    assert.equal(hasCache(), true);
    assert.ok(lines.some((l) => l.includes('last Space-Track fetch succeeded less than 1 hour ago')));
  });

  it('a corrupt log means allowed, and it is replaced by a valid record', async () => {
    fs.writeFileSync(attemptLogPath(), 'garbage{{', 'utf8');
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(stCalls, 1);
    assert.deepEqual(readAttemptState(), stateOnSuccess(T0));
  });

  it('an unwritable log does not block the cycle', async () => {
    fs.mkdirSync(attemptLogPath()); // read and write both fail
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(stCalls, 1);
    assert.equal(hasCache(), true);
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('attempt log')));
  });

  it('the pending record is written before the login starts', async () => {
    let seenDuringFetch: ReturnType<typeof readAttemptState> = null;
    await runUpdateCycle(
      'boot',
      deps('ok', 'fail', {
        fetchSpaceTrack: async () => {
          seenDuringFetch = readAttemptState();
          return { gp: spaceTrackGp(3) };
        },
      }),
    );
    assert.equal(seenDuringFetch!.lastOutcome, 'started');
    assert.equal(seenDuringFetch!.consecutiveFailures, 1);
  });

  it('data fetched but not saved (disk full) stays a failure and backs off', async () => {
    // a directory where the temp file goes makes writeCache throw
    fs.mkdirSync(path.join(tmpDir, 'tle-cache.json.tmp'));
    await assert.rejects(runUpdateCycle('boot', deps('ok', 'fail')));
    const state = readAttemptState();
    assert.equal(state?.lastOutcome, 'started');
    assert.equal(state?.consecutiveFailures, 1);
    clock = T0 + 10 * 1000;
    await runUpdateCycle('boot', deps('ok', 'ok')).catch(() => undefined);
    assert.equal(stCalls, 1, 'second login held back');
  });

  it('without credentials the log is not used', async () => {
    const unconfigured = { spaceTrackConfigured: () => false };
    await runUpdateCycle('boot', deps('fail', 'fail', unconfigured));
    assert.equal(stCalls, 1, 'the (throwing) call is made exactly as before');
    assert.equal(fs.existsSync(attemptLogPath()), false);
    // and a second cycle is not held back
    clock = T0 + MIN;
    await runUpdateCycle('boot', deps('fail', 'fail', unconfigured));
    assert.equal(stCalls, 2);
    assert.equal(fs.existsSync(attemptLogPath()), false);
  });
});
