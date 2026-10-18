// runUpdateCycle: the 5-per-UTC-day Space-Track cap, the alert on the day's 5th
// failure, and the CelesTrak overlay fallback. Every upstream is a fake, the clock
// is injected, the alert sender is a recorder, the cache dir is a real temp dir.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import {
  buildDailyFailureAlert,
  buildFromCelesTrak,
  cancelUpdateRetry,
  pendingUpdateRetryAt,
  runUpdateCycle,
  type UpdateCycleDeps,
} from '../../src/cron/tle-updater.js';
import { readCache, writeCache } from '../../src/cache/file-cache.js';
import { readAttemptState, writeAttemptState, type AttemptState } from '../../src/cache/attempt-log.js';
import type { AlertMessage } from '../../src/utils/alert.js';
import { celesTrakGp, spaceTrackGp } from './gp-fixtures.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY0 = '2026-10-14';
// Five failing attempts fit in one UTC day with the 15 m, 30 m, 1 h, 2 h backoffs between them.
const ATTEMPT_TIMES = ['00:10', '00:25', '00:55', '01:55', '03:55'].map((t) => Date.parse(`${DAY0}T${t}:00.000Z`));
const ST_ERROR = 'Space-Track login rejected (HTTP 500)';

describe('runUpdateCycle — daily cap, alert and CelesTrak overlay', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let lines: string[];
  let clock: number;
  let stCalls: number;
  let ctCalls: number;
  let alerts: AlertMessage[];
  let timers: Array<{ fn: () => void; delayMs: number; cancelled: boolean }>;
  let stBehaviour: 'fail' | 'ok';
  let ctRecords: ReturnType<typeof celesTrakGp> | Error;
  let senderMode: 'record' | 'throw' | 'reject';

  function deps(over: Partial<UpdateCycleDeps> = {}): Partial<UpdateCycleDeps> {
    return {
      spaceTrackConfigured: () => true,
      now: () => clock,
      fetchSpaceTrack: async () => {
        stCalls++;
        if (stBehaviour === 'fail') throw new Error(ST_ERROR);
        return { gp: spaceTrackGp(3) };
      },
      fetchCelesTrak: async () => {
        ctCalls++;
        if (ctRecords instanceof Error) throw ctRecords;
        return ctRecords;
      },
      sendAlert: (a) => {
        alerts.push(a);
        if (senderMode === 'throw') throw new Error('sender exploded');
        if (senderMode === 'reject') return Promise.reject(new Error('sender rejected'));
      },
      schedule: (fn, delayMs) => {
        const t = { fn, delayMs, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
      ...over,
    };
  }

  const run = async (at: number, trigger: 'boot' | 'cron' = 'boot') => {
    clock = at;
    await runUpdateCycle(trigger, deps());
  };

  const cachePath = () => path.join(tmpDir, 'tle-cache.json');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cap-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    lines = [];
    clock = ATTEMPT_TIMES[0];
    stCalls = 0;
    ctCalls = 0;
    alerts = [];
    timers = [];
    stBehaviour = 'fail';
    ctRecords = new Error('CelesTrak down');
    senderMode = 'record';
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

  describe('daily cap', () => {
    it('allows 5 attempts, then holds Space-Track back until 00:00 UTC and arms the retry for then', async () => {
      for (const at of ATTEMPT_TIMES) await run(at);
      assert.equal(stCalls, 5);
      assert.equal(readAttemptState()?.attemptsToday, 5);

      const later = Date.parse(`${DAY0}T10:00:00.000Z`);
      cancelUpdateRetry(); // the backoff timers armed by the earlier failures have "fired" by now
      timers.length = 0;
      await run(later);
      assert.equal(stCalls, 5, 'the 6th login is not made');
      const skip = lines.filter((l) => l.includes('Space-Track attempt skipped')).pop() ?? '';
      assert.match(skip, /daily limit of 5/);
      assert.ok(skip.includes('2026-10-15T00:00:00.000Z'), skip);

      const midnight = Date.parse('2026-10-15T00:00:00.000Z');
      assert.equal(pendingUpdateRetryAt(), midnight);
      const live = timers.filter((t) => !t.cancelled);
      assert.equal(live.length, 1);
      assert.ok(live[0].delayMs >= midnight - later && live[0].delayMs <= midnight - later + 5_000);
      assert.ok(live[0].delayMs < 2 ** 31 - 1);
    });

    it('boot, cron and retry-timer attempts all count', async () => {
      await run(ATTEMPT_TIMES[0], 'boot');
      await run(ATTEMPT_TIMES[1], 'cron');
      assert.equal(readAttemptState()?.attemptsToday, 2);
      assert.equal(stCalls, 2);
    });

    it('the next UTC day starts at zero, so the 02:00 cron after a capped day runs', async () => {
      for (const at of ATTEMPT_TIMES) await run(at);
      // the 5th failure was at 03:55: a 4 h backoff would have run past 07:55, but the day is over at midnight
      await run(Date.parse('2026-10-15T02:00:00.000Z'), 'cron');
      assert.equal(stCalls, 6);
      assert.equal(readAttemptState()?.attemptsToday, 1);
      assert.equal(readAttemptState()?.attemptDay, '2026-10-15');
    });

    it('a success counts too, and with the cap used the next try waits for midnight', async () => {
      writeAttemptState({
        lastAttemptAt: new Date(ATTEMPT_TIMES[3]).toISOString(),
        lastOutcome: 'failure',
        consecutiveFailures: 4,
        attemptDay: DAY0,
        attemptsToday: 4,
      });
      stBehaviour = 'ok';
      await run(ATTEMPT_TIMES[4]); // the 5th, succeeds
      assert.equal(stCalls, 1);
      const state = readAttemptState();
      assert.equal(state?.lastOutcome, 'success');
      assert.equal(state?.attemptsToday, 5);
      assert.equal(state?.successToday, true);
      // later the same day, cache old enough: cap still shuts the gate
      fs.utimesSync(cachePath(), new Date(ATTEMPT_TIMES[4] - 30 * HOUR), new Date(ATTEMPT_TIMES[4] - 30 * HOUR));
      stBehaviour = 'fail';
      await run(Date.parse(`${DAY0}T12:00:00.000Z`));
      assert.equal(stCalls, 1);
    });

    it('an old-format log file (no daily fields) is read as 0 attempts today', async () => {
      writeAttemptState({
        lastAttemptAt: new Date(ATTEMPT_TIMES[0] - HOUR).toISOString(),
        lastOutcome: 'failure',
        consecutiveFailures: 1,
      });
      await run(ATTEMPT_TIMES[0]);
      assert.equal(stCalls, 1);
      assert.equal(readAttemptState()?.attemptsToday, 1);
    });
  });

  describe('alert on the 5th failure', () => {
    it('fires once, on the 5th failed attempt, not on the 4th', async () => {
      for (const at of ATTEMPT_TIMES.slice(0, 4)) await run(at);
      assert.equal(alerts.length, 0, 'nothing after 4 failures');

      await run(ATTEMPT_TIMES[4]);
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].title, /Space-Track/);
      assert.match(alerts[0].body, /All 5 Space-Track attempts today/);
      assert.ok(alerts[0].body.includes(ST_ERROR), alerts[0].body);
      assert.match(alerts[0].body, /no catalog on disk/);
      assert.equal(readAttemptState()?.alertSentDay, DAY0);
    });

    it('says how old the served catalog is when there is one', async () => {
      writeCache([]);
      const when = new Date(ATTEMPT_TIMES[0] - 30 * HOUR);
      fs.utimesSync(cachePath(), when, when);
      for (const at of ATTEMPT_TIMES) await run(at);
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].body, /keeps serving the previous catalog/);
      assert.match(alerts[0].body, /about \d+ hours old/);
    });

    it('is not sent twice in one UTC day, also across a restart', async () => {
      for (const at of ATTEMPT_TIMES) await run(at);
      assert.equal(alerts.length, 1);
      // a "restart": same file on disk, more cycles the same day (all held back by the cap)
      await run(Date.parse(`${DAY0}T08:00:00.000Z`));
      await run(Date.parse(`${DAY0}T09:00:00.000Z`));
      assert.equal(alerts.length, 1);
    });

    it('is not sent again when a restart happens mid-way and the day was already alerted', async () => {
      const prior: AttemptState = {
        lastAttemptAt: new Date(ATTEMPT_TIMES[3]).toISOString(),
        lastOutcome: 'failure',
        consecutiveFailures: 4,
        attemptDay: DAY0,
        attemptsToday: 4,
        alertSentDay: DAY0,
      };
      writeAttemptState(prior);
      await run(ATTEMPT_TIMES[4]);
      assert.equal(stCalls, 1);
      assert.equal(alerts.length, 0);
    });

    it('is not sent when one of the day\'s attempts succeeded', async () => {
      writeAttemptState({
        lastAttemptAt: new Date(ATTEMPT_TIMES[3]).toISOString(),
        lastOutcome: 'failure',
        consecutiveFailures: 4,
        attemptDay: DAY0,
        attemptsToday: 4,
        successToday: true,
      });
      await run(ATTEMPT_TIMES[4]);
      assert.equal(stCalls, 1);
      assert.equal(readAttemptState()?.attemptsToday, 5);
      assert.equal(alerts.length, 0);
    });

    it('a new UTC day can alert again (yesterday\'s mark does not count)', async () => {
      for (const at of ATTEMPT_TIMES) await run(at);
      assert.equal(alerts.length, 1);
      // day 2: 4 attempts already failed, then the 5th fails. (A long outage backs off 6 h per
      // attempt, so in real life day 2 may not reach 5 attempts; this checks the day logic only.)
      writeAttemptState({
        lastAttemptAt: '2026-10-15T01:00:00.000Z',
        lastOutcome: 'failure',
        consecutiveFailures: 9,
        attemptDay: '2026-10-15',
        attemptsToday: 4,
        alertSentDay: DAY0,
      });
      await run(Date.parse('2026-10-15T08:00:00.000Z'), 'cron');
      assert.equal(alerts.length, 2);
      assert.equal(readAttemptState()?.alertSentDay, '2026-10-15');
    });

    it('a refused (empty) Space-Track catalog counts as a failure for the alert too', async () => {
      stBehaviour = 'ok';
      const emptyDeps = (): Partial<UpdateCycleDeps> => ({
        ...deps(),
        fetchSpaceTrack: async () => {
          stCalls++;
          return { gp: [] };
        },
      });
      for (const at of ATTEMPT_TIMES) {
        clock = at;
        await runUpdateCycle('boot', emptyDeps());
      }
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].body, /refused/);
    });

    it('a sender that throws, or rejects, never breaks the cycle', async () => {
      for (const mode of ['throw', 'reject'] as const) {
        senderMode = mode;
        fs.rmSync(path.join(tmpDir, 'spacetrack-attempts.json'), { force: true });
        for (const at of ATTEMPT_TIMES) await run(at);
        await new Promise((r) => setImmediate(r)); // let a rejected promise settle
        assert.ok(lines.some((l) => l.includes('WARN') && l.includes('Alert sender failed')), mode);
      }
      assert.equal(alerts.length, 2);
    });

    it('the alert text has no secrets and is bounded', () => {
      const long = 'x'.repeat(5000);
      const a = buildDailyFailureAlert(5, long, 3 * HOUR, true);
      assert.ok(a.body.length < 900, String(a.body.length));
      assert.match(a.body, /about 3 hours old/);
      assert.match(buildDailyFailureAlert(5, '', null, true).body, /age is not known/);
    });
  });

  describe('CelesTrak overlay fallback', () => {
    /** A cached catalog of real-shaped objects: ids 80000..80003 with the given epoch. */
    function seedCache(epoch: string): void {
      const records = celesTrakGp(4).map((r) => ({ ...r, EPOCH: epoch, OBJECT_NAME: `CACHED ${r.NORAD_CAT_ID}` }));
      writeCache(buildFromCelesTrak(records));
      const old = new Date(ATTEMPT_TIMES[0] - 30 * HOUR);
      fs.utimesSync(cachePath(), old, old);
    }
    const unconfigured: Partial<UpdateCycleDeps> = { spaceTrackConfigured: () => false };

    it('newer epoch wins, older is ignored, a new id is added, a 6-digit id survives, the rest stays', async () => {
      seedCache('2026-10-10T00:00:00.000000');
      const base = celesTrakGp(1)[0];
      ctRecords = [
        { ...base, NORAD_CAT_ID: 80000, EPOCH: '2026-10-13T00:00:00.000000', OBJECT_NAME: 'NEWER 80000' },
        { ...base, NORAD_CAT_ID: 80001, EPOCH: '2026-10-01T00:00:00.000000', OBJECT_NAME: 'OLDER 80001' },
        { ...base, NORAD_CAT_ID: 80002, EPOCH: '2026-10-10T00:00:00.000000', OBJECT_NAME: 'EQUAL 80002' },
        { ...base, NORAD_CAT_ID: 91000, EPOCH: '2026-10-13T00:00:00.000000', OBJECT_NAME: 'NEW 91000' },
        { ...base, NORAD_CAT_ID: 100001, EPOCH: '2026-10-13T00:00:00.000000', OBJECT_NAME: 'SIX DIGIT' },
      ];
      clock = ATTEMPT_TIMES[0];
      await runUpdateCycle('boot', { ...deps(), ...unconfigured });

      const out = readCache()!;
      const byId = new Map(out.map((o) => [o.noradId, o]));
      assert.equal(out.length, 6, '4 cached + 2 added');
      assert.equal(byId.get(80000)?.name, 'CACHED 80000', 'the cached name stays');
      assert.equal(byId.get(80000)?.epoch, '2026-10-13T00:00:00.000000Z', 'but the orbit is the newer one');
      assert.equal(byId.get(80000)?.omm.OBJECT_NAME, 'NEWER 80000');
      assert.equal(byId.get(80001)?.name, 'CACHED 80001');
      assert.equal(byId.get(80002)?.name, 'CACHED 80002');
      assert.equal(byId.get(80003)?.name, 'CACHED 80003', 'untouched');
      assert.equal(byId.get(91000)?.name, 'NEW 91000');
      assert.equal(byId.get(100001)?.name, 'SIX DIGIT');
      assert.equal(byId.get(100001)?.omm.NORAD_CAT_ID, 100001);
      assert.ok(lines.some((l) => l.includes('TLE update complete: 6 objects from celestrak')));
      assert.ok(lines.some((l) => l.includes('1 cached objects updated to newer orbits') && l.includes('2 added') && l.includes('3 kept')));
    });

    it('no cache: the overlay is just the CelesTrak records, 6-digit id included', async () => {
      const base = celesTrakGp(1)[0];
      ctRecords = [
        { ...base, NORAD_CAT_ID: 25544 },
        { ...base, NORAD_CAT_ID: 100001 },
      ];
      await runUpdateCycle('boot', { ...deps(), ...unconfigured });
      assert.deepEqual(readCache()!.map((o) => o.noradId).sort((a, b) => a - b), [25544, 100001]);
    });

    it('an empty CelesTrak answer is still refused and the cache stays byte for byte', async () => {
      seedCache('2026-10-10T00:00:00.000000');
      const before = fs.readFileSync(cachePath(), 'utf8');
      ctRecords = [];
      await runUpdateCycle('boot', { ...deps(), ...unconfigured });
      assert.equal(fs.readFileSync(cachePath(), 'utf8'), before);
      assert.ok(lines.some((l) => l.includes('CelesTrak catalog refused')));
    });

    it('history ingest is skipped for a CelesTrak result, and logged at INFO', async () => {
      ctRecords = celesTrakGp(2);
      await runUpdateCycle('boot', { ...deps(), ...unconfigured });
      const skip = lines.find((l) => l.includes('History ingest skipped'));
      assert.ok(skip, 'a skip line');
      assert.ok(skip.includes('INFO'));
      assert.ok(skip.includes('celestrak'));
      assert.equal(lines.some((l) => l.includes('History ingest:')), false);
    });

    it('a Space-Track result does not log the skip', async () => {
      stBehaviour = 'ok';
      await runUpdateCycle('boot', deps());
      assert.equal(lines.some((l) => l.includes('History ingest skipped')), false);
    });

    it('a gated CelesTrak (skipped error) is an INFO line and the stale cache is kept', async () => {
      seedCache('2026-10-10T00:00:00.000000');
      const before = fs.readFileSync(cachePath(), 'utf8');
      const { CelesTrakSkippedError } = await import('../../src/services/celestrak-http.js');
      ctRecords = new CelesTrakSkippedError('CelesTrak active download skipped (test)', clock + HOUR);
      await runUpdateCycle('boot', { ...deps(), ...unconfigured });
      assert.equal(fs.readFileSync(cachePath(), 'utf8'), before);
      const line = lines.find((l) => l.includes('CelesTrak active download skipped'));
      assert.ok(line?.includes('INFO'), line);
      assert.equal(lines.some((l) => l.includes('CelesTrak fallback also failed')), false);
    });
  });
});
