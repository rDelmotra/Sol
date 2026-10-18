// Volume alerts: injected statfs numbers, a fake clock, a recorded sender, a real temp
// cache dir for the once-a-day memory. No real disk is read, nothing is sent.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { alertStatePath, parseAlertState, readAlertState } from '../../src/cache/alert-state.js';
import { computeDiskUsage, type StatfsLike } from '../../src/utils/disk-usage.js';
import {
  VOLUME_GROWTH_HINT_MB_PER_DAY,
  buildVolumeAlert,
  maybeSendVolumeAlert,
  reportDiskAndAlert,
} from '../../src/utils/volume-alert.js';
import type { AlertMessage } from '../../src/utils/alert.js';

const MB = 1_048_576;
const bsize = 4096;
/** A statfs for a 444 MB volume that is `percent` full. */
function statfsAt(percent: number): StatfsLike {
  const blocks = Math.round((444 * MB) / bsize);
  const free = Math.round(blocks * (1 - percent / 100));
  return { bsize, blocks, bfree: free, bavail: free };
}
const usageAt = (percent: number) => computeDiskUsage(statfsAt(percent));

const DAY1 = Date.parse('2026-10-18T10:00:00.000Z');
const DAY2 = Date.parse('2026-10-19T10:00:00.000Z');

describe('volume alerts', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let alerts: AlertMessage[];
  let clock: number;
  let lines: string[];

  const deps = () => ({
    now: () => clock,
    sendAlert: (a: AlertMessage) => {
      alerts.push(a);
    },
  });
  const check = (percent: number) => maybeSendVolumeAlert(usageAt(percent), deps());

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-alert-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    alerts = [];
    clock = DAY1;
    lines = [];
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

  it('no alert at level ok', () => {
    assert.equal(check(0), 'ok');
    assert.equal(check(50), 'ok');
    assert.equal(check(74.9), 'ok');
    assert.equal(alerts.length, 0);
    assert.equal(fs.existsSync(alertStatePath()), false);
  });

  it('the thresholds are 75 (warn) and 90 (error)', () => {
    assert.equal(check(75), 'sent');
    assert.match(alerts[0].title, /VOLUME warn/);
    assert.equal(check(90), 'sent');
    assert.match(alerts[1].title, /VOLUME error/);
  });

  it('the first warn alert at 75% says what it must: used/total in MB, percent, level, growth hint, resize advice', () => {
    assert.equal(check(75.4), 'sent');
    const a = alerts[0];
    assert.match(a.title, /VOLUME/);
    assert.match(a.body, /75\.\d% full/);
    assert.match(a.body, /\d+\.\d MB used of 44\d\.\d MB/);
    assert.match(a.body, /level: warn/);
    assert.ok(a.body.includes(`${VOLUME_GROWTH_HINT_MB_PER_DAY} MB a day`));
    assert.match(a.body, /Resize the Railway volume/);
    assert.equal(VOLUME_GROWTH_HINT_MB_PER_DAY, 4.6);
  });

  it('production numbers (317 MB of 444 MB, about 71.5%) do not alert yet', () => {
    const prod = computeDiskUsage({ bsize, blocks: Math.round((444 * MB) / bsize), bfree: Math.round((127 * MB) / bsize), bavail: Math.round((127 * MB) / bsize) });
    assert.ok(prod.percent > 71 && prod.percent < 72, String(prod.percent));
    assert.equal(maybeSendVolumeAlert(prod, deps()), 'ok');
    assert.equal(alerts.length, 0);
  });

  it('at most once per UTC day per level', () => {
    assert.equal(check(80), 'sent');
    assert.equal(check(80), 'already-sent');
    clock = DAY1 + 5 * 60 * 60_000; // later the same UTC day
    assert.equal(check(81), 'already-sent');
    assert.equal(alerts.length, 1);
    clock = DAY2;
    assert.equal(check(81), 'sent');
    assert.equal(alerts.length, 2);
  });

  it('a worse level (warn then error) alerts again at once, the same day', () => {
    assert.equal(check(80), 'sent');
    assert.equal(check(91), 'sent');
    assert.equal(check(92), 'already-sent');
    assert.equal(alerts.length, 2);
    assert.match(alerts[1].body, /level: error/);
    assert.match(alerts[1].title, /VOLUME error/);
  });

  it('survives a restart: the marker is in alert-state.json', () => {
    check(80);
    const written = JSON.parse(fs.readFileSync(alertStatePath(), 'utf8'));
    assert.deepEqual(written, { volumeWarnDay: '2026-10-18' });
    // a "new process": nothing in memory but the file is read again
    assert.equal(check(80), 'already-sent');
    assert.deepEqual(readAlertState(), { volumeWarnDay: '2026-10-18' });
  });

  it('an unwritable state file does not repeat the alert within one run, and never throws', () => {
    fs.mkdirSync(alertStatePath()); // a directory where the file should be: read and write both fail
    assert.equal(check(80), 'sent');
    assert.equal(check(80), 'already-sent');
    assert.equal(alerts.length, 1);
  });

  it('a corrupt state file reads as nothing sent', () => {
    fs.writeFileSync(alertStatePath(), '{ not json', 'utf8');
    assert.equal(check(80), 'sent');
    assert.equal(alerts.length, 1);
  });

  it('a null report (platform cannot tell) is not an alert and not an error', () => {
    assert.equal(maybeSendVolumeAlert(null, deps()), 'unavailable');
    assert.equal(alerts.length, 0);
  });

  it('a sender that throws or rejects is logged at WARN and never propagates', async () => {
    const throwing = { now: () => clock, sendAlert: () => { throw new Error('boom'); } };
    assert.equal(maybeSendVolumeAlert(usageAt(80), throwing), 'sent');
    clock = DAY2;
    const rejecting = { now: () => clock, sendAlert: () => Promise.reject(new Error('nope')) };
    assert.equal(maybeSendVolumeAlert(usageAt(80), rejecting), 'sent');
    await new Promise((r) => setImmediate(r));
    assert.equal(lines.filter((l) => l.includes('Volume alert sender failed')).length, 2);
  });

  it('the body has no secrets and the days left follow the growth hint', () => {
    const a = buildVolumeAlert(usageAt(80), 'warn');
    // 20% of 444 MB left = 88.8 MB; at 4.6 MB a day that is 19 days
    assert.match(a.body, /about 19 days are left/);
    assert.doesNotMatch(a.body, /https?:/);
  });

  it('reportDiskAndAlert: logs the report, alerts on injected statfs numbers, returns the usage', async () => {
    const usage = await reportDiskAndAlert('test', {
      dir: tmpDir,
      statfs: async () => statfsAt(78),
      deps: deps(),
    });
    assert.equal(usage?.level, 'warn');
    assert.equal(alerts.length, 1);
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('Disk usage (test)')));
    // and at ok: logs, no alert
    const ok = await reportDiskAndAlert('test', { dir: tmpDir, statfs: async () => statfsAt(10), deps: deps() });
    assert.equal(ok?.level, 'ok');
    assert.equal(alerts.length, 1);
  });

  it('reportDiskAndAlert never throws when statfs fails', async () => {
    const usage = await reportDiskAndAlert('test', {
      dir: tmpDir,
      statfs: async () => {
        throw new Error('EIO');
      },
      deps: deps(),
    });
    assert.equal(usage, null);
    assert.equal(alerts.length, 0);
  });
});

describe('alert-state file shape', () => {
  it('keeps valid days, drops everything else', () => {
    assert.deepEqual(
      parseAlertState({ volumeWarnDay: '2026-10-18', volumeErrorDay: 'yesterday', writeFailureDay: '2026-10-17', extra: 1 }),
      { volumeWarnDay: '2026-10-18', writeFailureDay: '2026-10-17' },
    );
    assert.equal(parseAlertState(null), null);
    assert.equal(parseAlertState([]), null);
    assert.deepEqual(parseAlertState({}), {});
  });
});
