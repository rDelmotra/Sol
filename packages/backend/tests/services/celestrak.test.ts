// CelesTrak calling rules: no retry on 4xx, retries only for timeouts/network/5xx,
// a persisted 2 hour gate per group, the `active` group, decay filter, dedupe and
// 6-digit ids. axios is replaced at the module seam: no network, no real timers.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import {
  CELESTRAK_MIN_GAP_MS,
  celesTrakAttemptsPath,
  checkCelesTrakGate,
  evaluateCelesTrakGate,
  parseCelesTrakAttempts,
  readCelesTrakAttempts,
} from '../../src/cache/celestrak-attempts.js';
import { fetchCelesTrakTLEs } from '../../src/services/celestrak.js';
import { fetchCelesTrakVisualNoradIds } from '../../src/services/celestrak-visual.js';
import {
  CelesTrakHttpError,
  CelesTrakSkippedError,
  celesTrakGet,
  gatedCelesTrakGet,
} from '../../src/services/celestrak-http.js';
import { celesTrakGp } from '../cron/gp-fixtures.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-10-14T02:00:00.000Z');

function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

describe('CelesTrak calling rules', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let lines: string[];
  let urls: string[];
  /** One entry per expected request: data to return, or an Error to throw. */
  let script: Array<unknown>;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'celestrak-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    lines = [];
    urls = [];
    script = [];
    clock = T0;
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
    mock.method(axios, 'get', async (url: string) => {
      urls.push(url);
      const next = script.shift();
      if (next === undefined) throw new Error('unexpected extra request');
      if (next instanceof Error) throw next;
      return { data: next };
    });
  });

  afterEach(() => {
    mock.restoreAll();
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('no retry on 4xx', () => {
    for (const status of [403, 404, 429]) {
      it(`HTTP ${status}: exactly one request, and the error names the status`, async () => {
        script = [httpError(status)];
        await assert.rejects(
          () => celesTrakGet('https://example.test/x', { label: 'CelesTrak', timeoutMs: 1, retryCount: 3, retryDelayMs: 0 }),
          (err: Error) => {
            assert.ok(err instanceof CelesTrakHttpError);
            assert.equal((err as CelesTrakHttpError).httpStatus, status);
            assert.ok(err.message.includes(`HTTP ${status}`), err.message);
            assert.match(err.message, /not retrying/);
            return true;
          },
        );
        assert.equal(urls.length, 1, 'no second request');
      });
    }
  });

  describe('retries', () => {
    const opts = { label: 'CelesTrak', timeoutMs: 1, retryCount: 3, retryDelayMs: 0 };

    it('5xx is retried, at most 3 requests', async () => {
      script = [httpError(503), httpError(502), httpError(500)];
      await assert.rejects(() => celesTrakGet('https://example.test/x', opts), /failed after 3 attempts/);
      assert.equal(urls.length, 3);
    });

    it('timeouts and network errors are retried, and a later success wins', async () => {
      script = [Object.assign(new Error('timeout of 1ms exceeded'), { code: 'ECONNABORTED' }), new Error('socket hang up'), [{ ok: 1 }]];
      const data = await celesTrakGet<unknown[]>('https://example.test/x', opts);
      assert.deepEqual(data, [{ ok: 1 }]);
      assert.equal(urls.length, 3);
    });

    it('a 5xx followed by a 403 stops at the 403', async () => {
      script = [httpError(503), httpError(403), []];
      await assert.rejects(() => celesTrakGet('https://example.test/x', opts), CelesTrakHttpError);
      assert.equal(urls.length, 2);
    });
  });

  describe('the 2 hour gate (celestrak-attempts.json)', () => {
    it('evaluateCelesTrakGate: open with no record, shut for 2 hours after any attempt', () => {
      assert.deepEqual(evaluateCelesTrakGate(null, 'active', T0), { allowed: true });
      for (const lastOutcome of ['success', 'failure', 'started'] as const) {
        const attempts = { active: { lastAttemptAt: new Date(T0).toISOString(), lastOutcome } };
        const early = evaluateCelesTrakGate(attempts, 'active', T0 + 2 * HOUR - 1);
        assert.equal(early.allowed, false, lastOutcome);
        if (!early.allowed) assert.equal(early.retryAt, T0 + CELESTRAK_MIN_GAP_MS);
        assert.deepEqual(evaluateCelesTrakGate(attempts, 'active', T0 + 2 * HOUR), { allowed: true });
      }
    });

    it('groups are independent', () => {
      const attempts = { active: { lastAttemptAt: new Date(T0).toISOString(), lastOutcome: 'success' as const } };
      assert.deepEqual(evaluateCelesTrakGate(attempts, 'visual', T0 + MIN), { allowed: true });
    });

    it('a stamp in the future waits at most one gap', () => {
      const attempts = { active: { lastAttemptAt: new Date(T0 + 10 * 24 * HOUR).toISOString(), lastOutcome: 'success' as const } };
      const d = evaluateCelesTrakGate(attempts, 'active', T0);
      assert.equal(d.allowed, false);
      if (!d.allowed) assert.equal(d.retryAt, T0 + 2 * HOUR);
    });

    it('a success: the next call within 2 hours is skipped without a request, then allowed', async () => {
      script = [celesTrakGp(2), celesTrakGp(2)];
      const first = await fetchCelesTrakTLEs(now);
      assert.equal(first.length, 2);
      assert.equal(urls.length, 1);

      clock = T0 + 2 * HOUR - 1;
      await assert.rejects(() => fetchCelesTrakTLEs(now), CelesTrakSkippedError);
      assert.equal(urls.length, 1, 'no request while gated');

      clock = T0 + 2 * HOUR;
      await fetchCelesTrakTLEs(now);
      assert.equal(urls.length, 2);
    });

    it('a 403: one request, recorded with its status, and then 2 hours of quiet', async () => {
      script = [httpError(403)];
      await assert.rejects(() => fetchCelesTrakTLEs(now), (e: Error) => e.message.includes('HTTP 403'));
      assert.equal(urls.length, 1);
      const state = readCelesTrakAttempts()?.active;
      assert.equal(state?.lastOutcome, 'failure');
      assert.equal(state?.lastHttpStatus, 403);

      clock = T0 + HOUR;
      await assert.rejects(() => fetchCelesTrakTLEs(now), CelesTrakSkippedError);
      assert.equal(urls.length, 1);
      clock = T0 + 2 * HOUR;
      script = [celesTrakGp(1)];
      await fetchCelesTrakTLEs(now);
      assert.equal(urls.length, 2);
    });

    it('a 404 waits the same 2 hours', async () => {
      script = [httpError(404)];
      await assert.rejects(() => fetchCelesTrakTLEs(now), (e: Error) => e.message.includes('HTTP 404'));
      assert.equal(checkCelesTrakGate('active', T0 + 2 * HOUR - 1).allowed, false);
      assert.equal(checkCelesTrakGate('active', T0 + 2 * HOUR).allowed, true);
    });

    it('a 5xx run (3 tries) is one attempt for the gate', async () => {
      script = [httpError(503), httpError(503), httpError(503)];
      await assert.rejects(() =>
        gatedCelesTrakGet('active', 'https://example.test/x', { label: 'CelesTrak', timeoutMs: 1, retryCount: 3, retryDelayMs: 0 }, now),
      );
      assert.equal(urls.length, 3);
      assert.equal(checkCelesTrakGate('active', T0 + MIN).allowed, false);
    });

    it('the pending record is on disk before the request (a crash still holds the next one back)', async () => {
      let seen: ReturnType<typeof readCelesTrakAttempts> = null;
      mock.method(axios, 'get', async () => {
        seen = readCelesTrakAttempts();
        return { data: celesTrakGp(1) };
      });
      await fetchCelesTrakTLEs(now);
      assert.equal(seen!.active.lastOutcome, 'started');
    });

    it('a missing, corrupt or wrongly shaped file means allowed', () => {
      assert.equal(readCelesTrakAttempts(), null);
      assert.equal(checkCelesTrakGate('active', T0).allowed, true);
      fs.writeFileSync(celesTrakAttemptsPath(), '{ nope', 'utf8');
      assert.equal(checkCelesTrakGate('active', T0).allowed, true);
      fs.writeFileSync(celesTrakAttemptsPath(), '[1,2]', 'utf8');
      assert.equal(checkCelesTrakGate('active', T0).allowed, true);
      assert.deepEqual(parseCelesTrakAttempts({ active: { lastAttemptAt: 'x', lastOutcome: 'success' }, ok: { lastAttemptAt: new Date(T0).toISOString(), lastOutcome: 'failure', lastHttpStatus: 403 } }), {
        ok: { lastAttemptAt: new Date(T0).toISOString(), lastOutcome: 'failure', lastHttpStatus: 403 },
      });
    });

    it('an unwritable file only warns: the download still happens', async () => {
      fs.mkdirSync(celesTrakAttemptsPath()); // a directory where the file should be
      script = [celesTrakGp(1)];
      const out = await fetchCelesTrakTLEs(now);
      assert.equal(out.length, 1);
      assert.ok(lines.some((l) => l.includes('WARN') && l.includes('CelesTrak attempt log')));
    });

    it('writes atomically and touches nothing else in the cache dir', async () => {
      const other = path.join(tmpDir, 'tle-cache.json');
      fs.writeFileSync(other, '[1]', 'utf8');
      script = [celesTrakGp(1)];
      await fetchCelesTrakTLEs(now);
      assert.deepEqual(fs.readdirSync(tmpDir).sort(), ['celestrak-attempts.json', 'tle-cache.json']);
      assert.equal(fs.readFileSync(other, 'utf8'), '[1]');
    });
  });

  describe('the catalog fetch', () => {
    it('asks for GROUP=active in JSON, not last-30-days', async () => {
      script = [celesTrakGp(1)];
      await fetchCelesTrakTLEs(now);
      assert.match(urls[0], /GROUP=active/);
      assert.match(urls[0], /FORMAT=json/);
      assert.equal(urls[0].includes('last-30-days'), false);
    });

    it('drops decayed objects, de-duplicates by id keeping the newest epoch, keeps 6-digit ids', async () => {
      const base = celesTrakGp(1)[0];
      script = [
        [
          { ...base, NORAD_CAT_ID: 1001, EPOCH: '2026-10-10T00:00:00.000000' },
          { ...base, NORAD_CAT_ID: 1001, EPOCH: '2026-10-12T00:00:00.000000', OBJECT_NAME: 'NEWEST' },
          { ...base, NORAD_CAT_ID: 1001, EPOCH: '2026-10-11T00:00:00.000000' },
          { ...base, NORAD_CAT_ID: 1002, DECAY_DATE: '2026-09-01' },
          { ...base, NORAD_CAT_ID: 100001, OBJECT_NAME: 'SIX DIGIT' },
        ],
      ];
      const out = await fetchCelesTrakTLEs(now);
      assert.deepEqual(out.map((o) => o.NORAD_CAT_ID).sort((a, b) => a - b), [1001, 100001]);
      assert.equal(out.find((o) => o.NORAD_CAT_ID === 1001)?.OBJECT_NAME, 'NEWEST');
      assert.equal(out.some((o) => o.NORAD_CAT_ID === 1002), false);
    });

    it('a body that is not an array is an error', async () => {
      script = ['<html>oops</html>'];
      await assert.rejects(() => fetchCelesTrakTLEs(now), /non-array/);
    });
  });

  describe('the visual list uses the same rules', () => {
    it('a 403 is not retried and a repeat inside 2 hours makes no request', async () => {
      script = [httpError(403)];
      await assert.rejects(() => fetchCelesTrakVisualNoradIds(now), (e: Error) => e.message.includes('HTTP 403'));
      assert.equal(urls.length, 1);
      clock = T0 + HOUR;
      await assert.rejects(() => fetchCelesTrakVisualNoradIds(now), CelesTrakSkippedError);
      assert.equal(urls.length, 1);
    });

    it('works and is gated separately from the catalog group', async () => {
      script = [[{ NORAD_CAT_ID: 25544 }, { NORAD_CAT_ID: '100001' }], celesTrakGp(1)];
      assert.deepEqual(await fetchCelesTrakVisualNoradIds(now), [25544, 100001]);
      assert.match(urls[0], /GROUP=visual/);
      await fetchCelesTrakTLEs(now); // the active group is not held back by the visual one
      assert.equal(urls.length, 2);
      assert.deepEqual(Object.keys(readCelesTrakAttempts() ?? {}).sort(), ['active', 'visual']);
    });
  });

  describe('ntfy alert on every real CelesTrak call', () => {
    it('is sent once with the record count when the request succeeds', async () => {
      mock.method(axios, 'get', async () => ({ data: celesTrakGp(3) }));
      const sent: { title: string; body: string }[] = [];
      await fetchCelesTrakTLEs(() => T0, (a) => void sent.push(a));
      assert.equal(sent.length, 1);
      assert.match(sent[0].title, /CelesTrak was called$/);
      assert.match(sent[0].body, /3 records/);
    });

    it('is sent when the request fails, with the reason, and the error still propagates', async () => {
      mock.method(axios, 'get', async () => {
        throw httpError(403);
      });
      const sent: { title: string; body: string }[] = [];
      await assert.rejects(fetchCelesTrakTLEs(() => T0, (a) => void sent.push(a)));
      assert.equal(sent.length, 1);
      assert.match(sent[0].title, /called and failed/);
      assert.match(sent[0].body, /403/);
    });

    it('is NOT sent when the 2 hour gate skips the call (no request was made)', async () => {
      mock.method(axios, 'get', async () => ({ data: celesTrakGp(3) }));
      await fetchCelesTrakTLEs(() => T0, () => undefined);
      const sent: unknown[] = [];
      await assert.rejects(fetchCelesTrakTLEs(() => T0 + 10 * MIN, (a) => void sent.push(a)), CelesTrakSkippedError);
      assert.equal(sent.length, 0);
    });

    it('a sender that rejects never breaks the fetch', async () => {
      mock.method(axios, 'get', async () => ({ data: celesTrakGp(2) }));
      const out = await fetchCelesTrakTLEs(() => T0, () => Promise.reject(new Error('down')).catch(() => undefined));
      assert.equal(out.length, 2);
    });
  });
});
