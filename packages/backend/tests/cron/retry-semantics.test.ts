// The owner's rule, end to end: Space-Track is tried at most 5 times per UTC day, even when
// CelesTrak has kept the cache fresh; if all 5 of a day's attempts fail ONE alert goes out
// that day, and again every following day the outage lasts. Plus: a failed cache write (disk
// full) counts as a failure, alerts as a disk problem, and keeps serving the old cache.
//
// Everything is fake: fetchers, clock, the retry timer (a recorded callback that the test
// fires at the moment the production code asked for) and the alert sender. The cache dir is
// a real temp dir.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import {
  buildDailyFailureAlert,
  buildWriteFailureAlert,
  cancelUpdateRetry,
  pendingUpdateRetryAt,
  resumeSpaceTrackRetry,
  runScheduledCycle,
  runUpdateCycle,
  type CycleTrigger,
  type UpdateCycleDeps,
} from '../../src/cron/tle-updater.js';
import { cacheAgeMs, readCache, writeCache } from '../../src/cache/file-cache.js';
import { readAttemptState, writeAttemptState, stateOnFailure, stateOnStart } from '../../src/cache/attempt-log.js';
import { recordCelesTrakSuccess } from '../../src/cache/celestrak-attempts.js';
import { CelesTrakSkippedError } from '../../src/services/celestrak-http.js';
import type { AlertMessage } from '../../src/utils/alert.js';
import { celesTrakGp, fakeCatalog, spaceTrackGp } from './gp-fixtures.js';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const at = (iso: string) => Date.parse(iso);
const DAY1 = '2026-10-14';
const ST_ERROR = 'Space-Track login rejected (HTTP 500)';

interface FakeTimer {
  fn: () => void;
  delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

describe('Space-Track retries, daily alert and write failures', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let lines: string[];
  let clock: number;
  let stCalls: number;
  let stAttemptTimes: number[];
  let ctCalls: number;
  let ctDownloads: number;
  let ctLastDownload: number;
  let alerts: AlertMessage[];
  let timers: FakeTimer[];
  let stBehaviour: 'fail' | 'ok';
  let ctBehaviour: 'ok' | 'down';
  let writer: UpdateCycleDeps['writeCache'];
  let diskLine: string | null;

  const cachePath = () => path.join(tmpDir, 'tle-cache.json');
  const live = () => timers.filter((t) => !t.cancelled && !t.fired);

  /** writeCache, then stamp the file with the fake clock so cache ages make sense. */
  const pinningWriter: UpdateCycleDeps['writeCache'] = (data) => {
    writeCache(data);
    const when = new Date(clock);
    fs.utimesSync(cachePath(), when, when);
  };

  function deps(): Partial<UpdateCycleDeps> {
    return {
      spaceTrackConfigured: () => true,
      now: () => clock,
      fetchSpaceTrack: async () => {
        stCalls++;
        stAttemptTimes.push(clock);
        if (stBehaviour === 'fail') throw new Error(ST_ERROR);
        return { gp: spaceTrackGp(3) };
      },
      // CelesTrak behind its own 2 hour gate, like the real fetcher
      fetchCelesTrak: async () => {
        ctCalls++;
        if (ctBehaviour === 'down') throw new Error('CelesTrak down');
        if (clock < ctLastDownload + 2 * HOUR) {
          throw new CelesTrakSkippedError('CelesTrak active download skipped (2 h gate)', ctLastDownload + 2 * HOUR);
        }
        ctLastDownload = clock;
        ctDownloads++;
        return celesTrakGp(3);
      },
      sendAlert: (a) => {
        alerts.push(a);
      },
      schedule: (fn, delayMs) => {
        const t: FakeTimer = { fn, delayMs, cancelled: false, fired: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
      writeCache: (data) => writer(data),
      diskUsageLine: async () => diskLine,
    };
  }

  const cycle = async (when: number, trigger: CycleTrigger = 'cron') => {
    clock = when;
    await runUpdateCycle(trigger, deps());
  };

  /** Let un-awaited async work (a fired retry timer's cycle) finish. */
  const settle = async () => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
  };

  /** Fire the pending retry timer at the time the code asked for (plus its 1 s slack). */
  async function fireRetry(): Promise<void> {
    const due = pendingUpdateRetryAt();
    assert.notEqual(due, null, 'a retry timer is pending');
    const timer = live()[0];
    assert.ok(timer, 'a live timer');
    clock = due! + SEC;
    timer.fired = true;
    timer.fn();
    await settle();
  }

  /** Fire retries until no timer is pending or `max` fired. Returns how many fired. */
  async function runRetries(max: number): Promise<number> {
    let n = 0;
    while (pendingUpdateRetryAt() !== null && n < max) {
      await fireRetry();
      n++;
    }
    return n;
  }

  const staleCache = (when: number) => {
    writeCache(fakeCatalog(3));
    const old = new Date(when - 30 * HOUR);
    fs.utimesSync(cachePath(), old, old);
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-semantics-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    lines = [];
    clock = at(`${DAY1}T02:00:00.000Z`);
    stCalls = 0;
    stAttemptTimes = [];
    ctCalls = 0;
    ctDownloads = 0;
    ctLastDownload = Number.NEGATIVE_INFINITY;
    alerts = [];
    timers = [];
    stBehaviour = 'fail';
    ctBehaviour = 'ok';
    writer = pinningWriter;
    diskLine = 'disk 317.0 MB / 444.0 MB (71.4%)';
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

  // ------------------------------------------------------------------
  describe('CelesTrak does not stop the Space-Track retries', () => {
    it('after the 02:00 cron fails on Space-Track and CelesTrak refreshes the cache, the retry is still armed', async () => {
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      assert.equal(stCalls, 1);
      assert.equal(ctDownloads, 1);
      assert.ok((cacheAgeMs(clock) ?? Infinity) < MIN, 'the cache is fresh from CelesTrak');
      assert.equal(pendingUpdateRetryAt(), at(`${DAY1}T02:15:00.000Z`), 'next Space-Track try after the 15 min backoff');
      assert.equal(live().length, 1);
    });

    it('the retry runs although the cache is fresh, and uses up the day: 5 attempts, the 5th about 3 h 45 min after the 1st', async () => {
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      const fired = await runRetries(4);

      assert.equal(fired, 4, 'four retries after the cron attempt');
      assert.equal(stCalls, 5);
      const gaps = stAttemptTimes.slice(1).map((t, i) => Math.round((t - stAttemptTimes[i]) / MIN));
      assert.deepEqual(gaps, [15, 30, 60, 120], 'waits between attempts 1-2, 2-3, 3-4, 4-5 (minutes, plus seconds of slack)');
      const total = stAttemptTimes[4] - stAttemptTimes[0];
      assert.ok(total >= 225 * MIN && total < 226 * MIN, `5th attempt ${total / MIN} min after the 1st`);
      assert.equal(readAttemptState()?.attemptsToday, 5);
    });

    it('does not hit CelesTrak more often than its own 2 hour gate allows', async () => {
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      await runRetries(4);
      // attempts at 02:00, 02:15, 02:45, 03:45, 05:45: CelesTrak downloads at 02:00 and 05:45 only
      assert.equal(ctDownloads, 2);
      assert.equal(ctCalls, 5, 'the fetcher is asked each cycle; its gate says no inside the 2 h');
      assert.equal(lines.filter((l) => l.includes('CelesTrak active download skipped')).length, 3);
    });

    it('after the 5th failure there is no more Space-Track attempt today; the next timer waits for 00:00 UTC', async () => {
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      await runRetries(4);
      assert.equal(stCalls, 5);
      assert.equal(pendingUpdateRetryAt(), at('2026-10-15T00:00:00.000Z'));
      // a boot or cron later the same day is held back by the cap
      await cycle(at(`${DAY1}T12:00:00.000Z`), 'boot');
      assert.equal(stCalls, 5);
    });
  });

  // ------------------------------------------------------------------
  describe('the daily alert', () => {
    it('is sent once, on the 5th failure, and says CelesTrak kept the catalog fresh', async () => {
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      await runRetries(3);
      assert.equal(stCalls, 4);
      assert.equal(alerts.length, 0, 'nothing after 4 failures');

      await runRetries(1);
      assert.equal(stCalls, 5);
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].title, /Space-Track failed all daily attempts/);
      assert.match(alerts[0].body, /All 5 Space-Track attempts today/);
      assert.ok(alerts[0].body.includes(ST_ERROR));
      assert.match(alerts[0].body, /CelesTrak kept the catalog fresh/);
      assert.match(alerts[0].body, /about \d+ minutes? old/);
      assert.equal(readAttemptState()?.alertSentDay, DAY1);
    });

    it('says so when CelesTrak did not help either, and how old the catalog is', async () => {
      ctBehaviour = 'down';
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      await runRetries(4);
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].body, /keeps serving the previous catalog/);
      assert.match(alerts[0].body, /CelesTrak did not refresh it either/);
      assert.match(alerts[0].body, /about \d+ hours old/);
    });

    it('a day rollover resets the backoff and the cap, and the outage alerts again the next day (and the next)', async () => {
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      await runRetries(4);
      assert.equal(alerts.length, 1);
      assert.equal(pendingUpdateRetryAt(), at('2026-10-15T00:00:00.000Z'));

      // day 2: the midnight timer fires; the long day-1 backoff is gone, attempt 1 of day 2 happens at once
      await runRetries(1);
      assert.equal(stCalls, 6);
      assert.equal(stAttemptTimes[5], at('2026-10-15T00:00:01.000Z'));
      assert.equal(readAttemptState()?.attemptDay, '2026-10-15');
      assert.equal(readAttemptState()?.attemptsToday, 1);
      assert.equal(pendingUpdateRetryAt(), at('2026-10-15T00:15:01.000Z'), 'a 15 min backoff again, not a streak backoff');

      await runRetries(4);
      assert.equal(stCalls, 10, 'all 5 attempts are available again on day 2');
      assert.equal(alerts.length, 2);
      assert.match(alerts[1].title, /day 2 in a row/);
      assert.match(alerts[1].body, /This is day 2 in a row/);
      assert.equal(readAttemptState()?.alertSentDay, '2026-10-15');
      assert.equal(readAttemptState()?.alertStreakDays, 2);

      // day 3
      await runRetries(5);
      assert.equal(stCalls, 15);
      assert.equal(alerts.length, 3);
      assert.match(alerts[2].body, /This is day 3 in a row/);
    });

    it('is not sent when the 5th attempt succeeds', async () => {
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      await runRetries(3);
      assert.equal(stCalls, 4);
      stBehaviour = 'ok';
      await runRetries(1);
      assert.equal(stCalls, 5);
      assert.equal(alerts.length, 0);
      assert.equal(readAttemptState()?.lastOutcome, 'success');
      assert.equal(readAttemptState()?.attemptsToday, 5);
      assert.equal(pendingUpdateRetryAt(), null);
    });

    it('a success cancels the pending retry and ends the sequence', async () => {
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      await runRetries(1);
      assert.equal(stCalls, 2);
      assert.equal(live().length, 1);

      stBehaviour = 'ok';
      await runRetries(1);
      assert.equal(stCalls, 3);
      assert.equal(pendingUpdateRetryAt(), null);
      assert.equal(live().length, 0);
      assert.equal(alerts.length, 0);
      const cached = readCache()!;
      assert.ok(cached.some((o) => o.noradId === 90_000), 'the cache now holds the Space-Track catalog');
    });

    it('a refused (empty) Space-Track answer counts as a failure for the cap and the alert', async () => {
      staleCache(clock);
      const emptyAnswer = { ...deps(), fetchSpaceTrack: async () => ({ gp: [] }) };
      clock = at(`${DAY1}T02:00:00.000Z`);
      for (let i = 0; i < 5; i++) {
        await runUpdateCycle('retry', emptyAnswer);
        const due = pendingUpdateRetryAt();
        cancelUpdateRetry(); // as if the timer had fired
        if (due !== null) clock = due + SEC;
      }
      assert.equal(readAttemptState()?.attemptsToday, 5);
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].body, /refused/);
    });

    it('the alert text: days in a row, CelesTrak status and age are optional and bounded', () => {
      const long = 'x'.repeat(5000);
      const a = buildDailyFailureAlert(5, long, 3 * HOUR, true, { daysInARow: 4, celestrakRefreshed: false });
      assert.ok(a.body.length < 1000, String(a.body.length));
      assert.match(a.title, /day 4 in a row/);
      assert.match(a.body, /day 4 in a row/);
      assert.match(a.body, /about 3 hours old/);
      const plain = buildDailyFailureAlert(5, 'boom', 3 * HOUR, true);
      assert.doesNotMatch(plain.body, /in a row/);
      assert.doesNotMatch(plain.body, /CelesTrak/);
      assert.match(buildDailyFailureAlert(5, '', null, true).body, /age is not known/);
      assert.match(buildDailyFailureAlert(5, 'e', null, false, { celestrakRefreshed: true }).body, /no catalog on disk/);
    });

    it('CelesTrak counts as fresh when its last good download (persisted) was earlier today, even if this cycle was gated', async () => {
      staleCache(clock);
      stBehaviour = 'fail';
      ctBehaviour = 'down'; // this cycle's request fails ...
      writeAttemptState({
        lastAttemptAt: new Date(at(`${DAY1}T05:00:00.000Z`)).toISOString(),
        lastOutcome: 'failure',
        consecutiveFailures: 4,
        attemptDay: DAY1,
        attemptsToday: 4,
      });
      recordCelesTrakSuccess('active', at(`${DAY1}T04:00:00.000Z`)); // ... but it succeeded 2 h earlier
      await cycle(at(`${DAY1}T08:00:00.000Z`));
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].body, /CelesTrak kept the catalog fresh/);
    });
  });

  // ------------------------------------------------------------------
  describe('retry timer', () => {
    it('a retry that fires before the gate opens only re-arms: no login, no CelesTrak request', async () => {
      staleCache(clock);
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      const ctBefore = ctCalls;
      const timer = live()[0];
      clock = at(`${DAY1}T02:05:00.000Z`); // a clock jump: far too early
      timer.fired = true;
      timer.fn();
      await settle();
      assert.equal(stCalls, 1);
      assert.equal(ctCalls, ctBefore);
      assert.equal(pendingUpdateRetryAt(), at(`${DAY1}T02:15:00.000Z`));
    });

    it('after a restart the timer is armed again from the attempt log', () => {
      writeAttemptState(stateOnFailure(stateOnStart(null, at(`${DAY1}T02:00:00.000Z`)), at(`${DAY1}T02:00:01.000Z`)));
      clock = at(`${DAY1}T02:05:00.000Z`);
      resumeSpaceTrackRetry(deps());
      assert.equal(pendingUpdateRetryAt(), at(`${DAY1}T02:15:01.000Z`));
      assert.equal(live().length, 1);
      assert.equal(stCalls, 0, 'arming adds no attempt of its own');
    });

    it('after a restart nothing is armed when the last attempt succeeded, or without credentials, or with no log', () => {
      clock = at(`${DAY1}T02:05:00.000Z`);
      resumeSpaceTrackRetry(deps());
      assert.equal(pendingUpdateRetryAt(), null, 'no log');

      writeAttemptState({ lastAttemptAt: new Date(clock - 10 * MIN).toISOString(), lastOutcome: 'success', consecutiveFailures: 0 });
      resumeSpaceTrackRetry(deps());
      assert.equal(pendingUpdateRetryAt(), null, 'last attempt succeeded');

      writeAttemptState({ lastAttemptAt: new Date(clock - 10 * MIN).toISOString(), lastOutcome: 'failure', consecutiveFailures: 1 });
      resumeSpaceTrackRetry({ ...deps(), spaceTrackConfigured: () => false });
      assert.equal(pendingUpdateRetryAt(), null, 'no credentials');
    });
  });

  // ------------------------------------------------------------------
  describe('runScheduledCycle — the 02:00 cron run', () => {
    it('runs the update cycle, then the daily disk check', async () => {
      staleCache(clock);
      const order: string[] = [];
      clock = at(`${DAY1}T02:00:00.000Z`);
      const base = deps();
      await runScheduledCycle(
        {
          ...base,
          fetchSpaceTrack: async () => {
            order.push('cycle');
            return { gp: spaceTrackGp(3) };
          },
        },
        async () => {
          order.push('disk');
        },
      );
      assert.deepEqual(order, ['cycle', 'disk']);
    });

    it('a disk check that throws never rejects', async () => {
      staleCache(clock);
      await runScheduledCycle(deps(), async () => {
        throw new Error('statfs exploded');
      });
      assert.ok(lines.some((l) => l.includes('Daily disk check failed')));
    });
  });

  // ------------------------------------------------------------------
  describe('write failure (disk full, permissions)', () => {
    const tmpFile = () => path.join(tmpDir, 'tle-cache.json.tmp');

    /** A writer that leaves a half-written temp file behind and throws, like a full disk. */
    const fullDisk: UpdateCycleDeps['writeCache'] = () => {
      fs.writeFileSync(tmpFile(), 'partial');
      throw new Error('ENOSPC: no space left on device, write');
    };

    it('records a Space-Track failure, logs ERROR, removes our temp file, keeps serving the old cache, alerts, arms the retry', async () => {
      staleCache(clock);
      const before = fs.readFileSync(cachePath(), 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'other.tmp'), 'not ours');
      stBehaviour = 'ok';
      writer = fullDisk;

      await cycle(at(`${DAY1}T02:00:00.000Z`)); // must not throw

      assert.equal(stCalls, 1);
      const state = readAttemptState();
      assert.equal(state?.lastOutcome, 'failure');
      assert.equal(state?.attemptsToday, 1);
      assert.ok(lines.some((l) => l.includes('ERROR') && l.includes('Writing the catalog to disk failed') && l.includes('ENOSPC')));
      assert.equal(fs.existsSync(tmpFile()), false, 'our leftover temp file is removed');
      assert.equal(fs.readFileSync(path.join(tmpDir, 'other.tmp'), 'utf8'), 'not ours', 'nothing else is touched');
      assert.equal(fs.readFileSync(cachePath(), 'utf8'), before, 'the old cache is byte for byte what it was');
      assert.equal(readCache()!.length, 3);

      assert.equal(alerts.length, 1);
      assert.match(alerts[0].title, /DISK or WRITE problem/);
      assert.match(alerts[0].body, /ENOSPC/);
      assert.ok(alerts[0].body.includes('disk 317.0 MB / 444.0 MB (71.4%)'), alerts[0].body);
      assert.match(alerts[0].body, /failed Space-Track attempt 1 of 5/);
      assert.match(alerts[0].body, /keeps serving the previous catalog/);

      assert.equal(pendingUpdateRetryAt(), at(`${DAY1}T02:15:00.000Z`), 'the backoff applies and the retry is armed');
    });

    it('works without a disk line', async () => {
      staleCache(clock);
      stBehaviour = 'ok';
      writer = fullDisk;
      diskLine = null;
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      assert.equal(alerts.length, 1);
      assert.doesNotMatch(alerts[0].body, /disk \d/);
    });

    it('sends the disk alert at most once per UTC day, however many writes fail', async () => {
      staleCache(clock);
      stBehaviour = 'ok';
      writer = fullDisk;
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      await runRetries(3);
      assert.equal(stCalls, 4, 'each retry downloads again and fails to save');
      assert.equal(alerts.length, 1);
      assert.equal(readAttemptState()?.attemptsToday, 4);

      // the next day it alerts again
      await runRetries(1); // 5th attempt of day 1 (also the day's last: stands in for the daily alert)
      assert.equal(stCalls, 5);
      assert.equal(alerts.length, 2, 'the 5th failed write is the day\'s alert');
      assert.match(alerts[1].body, /All of today's attempts have failed/);
      assert.equal(readAttemptState()?.alertSentDay, DAY1);
      await runRetries(1); // day 2, attempt 1
      assert.equal(alerts.length, 3, 'a new day, a new disk alert');
    });

    it('the day\'s 5th attempt failing on the write sends ONE alert (disk wording), not two', async () => {
      staleCache(clock);
      stBehaviour = 'ok';
      writer = fullDisk;
      writeAttemptState({
        lastAttemptAt: new Date(at(`${DAY1}T01:55:00.000Z`)).toISOString(),
        lastOutcome: 'failure',
        consecutiveFailures: 4,
        attemptDay: DAY1,
        attemptsToday: 4,
      });
      // the disk alert already went out earlier today
      const { markAlertSent } = await import('../../src/cache/alert-state.js');
      markAlertSent('writeFailure', DAY1);
      await cycle(at(`${DAY1}T03:55:00.000Z`));
      assert.equal(readAttemptState()?.attemptsToday, 5);
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].title, /DISK or WRITE/);
      assert.equal(readAttemptState()?.alertSentDay, DAY1);
    });

    it('a CelesTrak result that cannot be saved: logged, alerted, old cache kept, and no Space-Track failure invented', async () => {
      staleCache(clock);
      const before = fs.readFileSync(cachePath(), 'utf8');
      writer = fullDisk;
      await cycle(at(`${DAY1}T02:00:00.000Z`)); // Space-Track fails (1 attempt), CelesTrak answers, the save fails
      assert.equal(stCalls, 1);
      assert.equal(readAttemptState()?.attemptsToday, 1, 'only the real Space-Track login is counted');
      assert.equal(fs.readFileSync(cachePath(), 'utf8'), before);
      assert.equal(fs.existsSync(tmpFile()), false);
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].title, /DISK or WRITE/);
      assert.doesNotMatch(alerts[0].body, /attempt \d of 5/);
      assert.equal(pendingUpdateRetryAt(), at(`${DAY1}T02:15:00.000Z`));
    });

    it('a failing temp-file cleanup is only a warning', async () => {
      staleCache(clock);
      stBehaviour = 'ok';
      fs.mkdirSync(tmpFile()); // a directory with our temp name: rmSync (no recursive) refuses it
      writer = () => {
        throw new Error('EACCES: permission denied');
      };
      await cycle(at(`${DAY1}T02:00:00.000Z`));
      assert.equal(alerts.length, 1);
      assert.ok(lines.some((l) => l.includes('WARN') && l.includes('Could not remove leftover temp file')));
    });

    it('a sender that throws does not break the cycle', async () => {
      staleCache(clock);
      stBehaviour = 'ok';
      writer = fullDisk;
      clock = at(`${DAY1}T02:00:00.000Z`);
      await runUpdateCycle('cron', {
        ...deps(),
        sendAlert: () => {
          throw new Error('sender exploded');
        },
      });
      assert.ok(lines.some((l) => l.includes('Alert sender failed')));
      assert.equal(readAttemptState()?.lastOutcome, 'failure');
    });

    it('the write-failure alert text has no secrets and is bounded', () => {
      const a = buildWriteFailureAlert({
        error: 'e'.repeat(5000),
        source: 'space-track',
        catalogAgeMs: 5 * HOUR,
        hasCatalog: true,
        diskLine: 'disk 1.0 MB / 2.0 MB (50%)',
        attemptsToday: 2,
      });
      assert.ok(a.body.length < 900, String(a.body.length));
      assert.match(a.title, /DISK or WRITE/);
      assert.match(a.body, /about 5 hours old/);
      assert.match(a.body, /CACHE_DIR/);
    });
  });
});
