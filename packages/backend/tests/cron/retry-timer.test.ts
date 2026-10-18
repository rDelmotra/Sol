// The one-shot retry after a Space-Track backoff. Fake fetchers, fake clock, fake
// timer (a recorded callback), real temp cache dir. No real timers run.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import {
  cancelUpdateRetry,
  pendingUpdateRetryAt,
  runUpdateCycle,
  scheduleTLEUpdater,
  type UpdateCycleDeps,
} from '../../src/cron/tle-updater.js';
import { writeCache } from '../../src/cache/file-cache.js';
import {
  attemptLogPath,
  readAttemptState,
  stateOnFailure,
  stateOnStart,
  stateOnSuccess,
  writeAttemptState,
} from '../../src/cache/attempt-log.js';
import { attemptCore, celesTrakGp, fakeCatalog, spaceTrackGp } from './gp-fixtures.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.now();

interface FakeTimer {
  fn: () => void;
  delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

describe('runUpdateCycle — retry timer after a Space-Track backoff', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let lines: string[];
  let clock: number;
  let stCalls: number;
  let ctCalls: number;
  let timers: FakeTimer[];

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
      schedule: (fn, delayMs) => {
        const timer: FakeTimer = { fn, delayMs, cancelled: false, fired: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      ...over,
    };
  }

  const live = () => timers.filter((t) => !t.cancelled && !t.fired);
  const fire = (t: FakeTimer) => {
    t.fired = true;
    t.fn();
  };
  const hasCache = () => fs.existsSync(path.join(tmpDir, 'tle-cache.json'));

  /** A stale cache (30 h old, 3 objects, like the fakes return) so a boot cycle really fetches. */
  function seedStaleCache(): void {
    writeCache(fakeCatalog(3));
    const old = new Date(T0 - 30 * HOUR);
    fs.utimesSync(path.join(tmpDir, 'tle-cache.json'), old, old);
  }

  /** The attempt log says: one failed login a minute ago -> next login at T0 + 14 min. */
  function backoffUntilPlus14Min(): void {
    writeAttemptState(stateOnFailure(stateOnStart(null, T0 - MIN), T0 - MIN));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-timer-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    lines = [];
    clock = T0;
    stCalls = 0;
    ctCalls = 0;
    timers = [];
    cancelUpdateRetry();
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });

  afterEach(() => {
    cancelUpdateRetry();
    mock.restoreAll();
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skipped by the backoff gate with nothing written: one timer, at the gate time', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();

    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(stCalls, 0, 'Space-Track was held back');
    assert.equal(live().length, 1);
    const retryAt = T0 + 14 * MIN;
    assert.equal(pendingUpdateRetryAt(), retryAt);
    // wakes up just after the gate opens, never before
    assert.ok(live()[0].delayMs >= 14 * MIN, String(live()[0].delayMs));
    assert.ok(live()[0].delayMs <= 14 * MIN + 5_000, String(live()[0].delayMs));
    assert.ok(lines.some((l) => l.includes('TLE update retry scheduled') && l.includes(new Date(retryAt).toISOString())));
  });

  it('when the timer fires after the wait, the cycle runs again and refreshes the cache', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(stCalls, 0);

    clock = T0 + 14 * MIN + 1_000;
    fire(live()[0]);
    // the retry cycle is async; let it finish
    await waitFor(() => stCalls === 1);

    assert.equal(stCalls, 1);
    await waitFor(() => readAttemptState()?.lastOutcome === 'success');
    assert.deepEqual(attemptCore(readAttemptState()), stateOnSuccess(clock));
    assert.equal(pendingUpdateRetryAt(), null);
    assert.equal(live().length, 0, 'no further timer after a success');
  });

  it('only one timer is pending, however many cycles are skipped', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();

    await runUpdateCycle('boot', deps('ok', 'fail'));
    await runUpdateCycle('boot', deps('ok', 'fail'));
    await runUpdateCycle('cron', deps('ok', 'fail'));
    assert.equal(timers.length, 1);
    assert.equal(live().length, 1);
  });

  it('a new, earlier time replaces the pending timer, a later one does not', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(pendingUpdateRetryAt(), T0 + 14 * MIN);

    // a later gate time: kept as is
    writeAttemptState({ lastAttemptAt: new Date(T0).toISOString(), lastOutcome: 'failure', consecutiveFailures: 3 });
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(timers.length, 1);
    assert.equal(pendingUpdateRetryAt(), T0 + 14 * MIN);

    // an earlier gate time: the old timer is cancelled, a new one armed
    writeAttemptState({ lastAttemptAt: new Date(T0 - 10 * MIN).toISOString(), lastOutcome: 'failure', consecutiveFailures: 1 });
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(timers.length, 2);
    assert.equal(timers[0].cancelled, true);
    assert.equal(pendingUpdateRetryAt(), T0 + 5 * MIN);
    assert.equal(live().length, 1);
  });

  it('shutdown cancels the pending timer', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(live().length, 1);

    cancelUpdateRetry();
    assert.equal(live().length, 0);
    assert.equal(timers[0].cancelled, true);
    assert.equal(pendingUpdateRetryAt(), null);
    cancelUpdateRetry(); // twice is fine
  });

  it('the handle from scheduleTLEUpdater stops the cron job and cancels the pending timer', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(live().length, 1);

    const handle = scheduleTLEUpdater(false);
    handle.stop();
    assert.equal(live().length, 0);
    assert.equal(pendingUpdateRetryAt(), null);
  });

  it('a Space-Track success cancels a pending timer', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(live().length, 1);

    // the wait is over, a cycle runs and Space-Track answers: the retry has nothing left to do
    clock = T0 + 15 * MIN;
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(stCalls, 1);
    assert.equal(hasCache(), true);
    assert.equal(readAttemptState()?.lastOutcome, 'success');
    assert.equal(live().length, 0);
    assert.equal(pendingUpdateRetryAt(), null);
  });

  it('a CelesTrak write does NOT cancel the pending timer', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(live().length, 1);

    // CelesTrak answers on the next cycle (Space-Track still held back) and refreshes the cache
    clock = T0 + MIN;
    await runUpdateCycle('boot', deps('ok', 'ok'));
    assert.equal(ctCalls, 2, 'one failed call before, one good call now');
    assert.equal(hasCache(), true);
    assert.equal(stCalls, 0, 'Space-Track is still held back');
    assert.equal(live().length, 1, 'the Space-Track retry is still pending');
    assert.equal(pendingUpdateRetryAt(), T0 + 14 * MIN);
  });

  it('both sources fail in this cycle: a timer is armed for the end of the new backoff (15 min)', async () => {
    seedStaleCache();
    await runUpdateCycle('boot', deps('fail', 'fail'));
    assert.equal(stCalls, 1);
    assert.equal(pendingUpdateRetryAt(), T0 + 15 * MIN);
    assert.equal(live().length, 1);
  });

  it('a refused (empty) Space-Track answer with CelesTrak down also arms the timer', async () => {
    seedStaleCache();
    await runUpdateCycle('boot', deps('ok', 'fail', { fetchSpaceTrack: async () => ({ gp: [] }) }));
    assert.equal(pendingUpdateRetryAt(), T0 + 15 * MIN);
  });

  it('CelesTrak filled the cache and Space-Track was held back: the retry for Space-Track is still armed', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();
    await runUpdateCycle('boot', deps('ok', 'ok'));
    assert.equal(ctCalls, 1);
    assert.equal(timers.length, 1);
    assert.equal(pendingUpdateRetryAt(), T0 + 14 * MIN);
  });

  it('no timer when the cache is fresh and the cycle is skipped', async () => {
    writeCache(fakeCatalog(10)); // just written: fresh
    backoffUntilPlus14Min();
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(timers.length, 0);
  });

  it('no timer without Space-Track credentials (nothing to wait for)', async () => {
    seedStaleCache();
    await runUpdateCycle('boot', deps('fail', 'fail', { spaceTrackConfigured: () => false }));
    assert.equal(timers.length, 0);
  });

  it('no timer when the attempt log cannot be written (the gate stays open: no hot loop)', async () => {
    seedStaleCache();
    fs.mkdirSync(attemptLogPath()); // read and write both fail
    await runUpdateCycle('boot', deps('fail', 'fail'));
    assert.equal(stCalls, 1);
    assert.equal(timers.length, 0);
  });

  it('a recent success with the cache file gone: the timer is armed for the end of the 1 hour gap', async () => {
    writeAttemptState(stateOnSuccess(T0 - 10 * MIN));
    await runUpdateCycle('boot', deps('ok', 'fail'));
    assert.equal(stCalls, 0);
    assert.equal(pendingUpdateRetryAt(), T0 + 50 * MIN);
  });

  it('a timer that fires before the gate really opens re-arms instead of logging in early', async () => {
    seedStaleCache();
    backoffUntilPlus14Min();
    await runUpdateCycle('boot', deps('ok', 'fail'));

    clock = T0 + 5 * MIN; // fires early, for example after a clock jump
    fire(live()[0]);
    await waitFor(() => timers.length === 2);
    assert.equal(stCalls, 0, 'Space-Track still held back');
    assert.equal(timers.length, 2);
    assert.equal(live().length, 1);
    assert.equal(pendingUpdateRetryAt(), T0 + 14 * MIN);
  });

  it('the default timer is a real unref\'d setTimeout', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      seedStaleCache();
      backoffUntilPlus14Min();
      const over = deps('ok', 'fail');
      delete over.schedule; // use the production timer
      await runUpdateCycle('boot', over);
      assert.equal(pendingUpdateRetryAt(), T0 + 14 * MIN);

      clock = T0 + 14 * MIN + 1_000;
      mock.timers.tick(14 * MIN + 5_000);
      await waitFor(() => stCalls === 1);
      assert.equal(stCalls, 1);
    } finally {
      mock.timers.reset();
    }
  });
});

/** Poll (with setImmediate) until `check()` is true, at most ~1 s. */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
