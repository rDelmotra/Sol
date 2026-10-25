// Boot order: the disk report is fire and forget, last, and guarded by a timeout,
// so a hung statfs can never delay scheduleTLEUpdater. Fakes only; no disk is read.

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import {
  BOOT_STEPS,
  DISK_REPORT_TIMEOUT_MS,
  MIRROR_RECOVERY_DELAY_MS,
  MIRROR_RECOVERY_MAX_ATTEMPTS,
  armMirrorRecovery,
  decideBootFetch,
  makeDiskReportStep,
  runBootTasks,
  startDiskReport,
  type BootStep,
  type MirrorRecoveryDeps,
} from '../src/boot.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('boot steps', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('the disk report is the last step, after the TLE updater is scheduled', () => {
    const names = BOOT_STEPS.map((s) => s.name);
    assert.equal(names.at(-1), 'disk-usage');
    assert.ok(names.indexOf('tle-freshness') >= 0);
    assert.ok(names.indexOf('tle-freshness') < names.indexOf('disk-usage'));
    assert.equal(names.filter((n) => n === 'disk-usage').length, 1);
  });

  it('the guard is 5 seconds', () => {
    assert.equal(DISK_REPORT_TIMEOUT_MS, 5_000);
  });

  it('a normal report settles when the work is done, without a warning', async () => {
    let ran = 0;
    await startDiskReport(async () => void (ran += 1), 5_000);
    assert.equal(ran, 1);
    assert.equal(lines.some((l) => l.includes('WARN')), false);
  });

  it('a hung statfs is given up on after the timeout, with a warning', async () => {
    const started = Date.now();
    await startDiskReport(() => new Promise(() => {}), 40);
    assert.ok(Date.now() - started < 1_000);
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('did not finish in 40 ms')));
  });

  it('a rejected report is caught and logged', async () => {
    await startDiskReport(() => Promise.reject(new Error('statfs exploded')), 5_000);
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('statfs exploded')));
  });

  it('a report that throws at once is caught and logged', async () => {
    await startDiskReport(() => {
      throw new Error('sync boom');
    }, 5_000);
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('sync boom')));
  });

  it('the step returns at once, even when the report never finishes', () => {
    // long guard on purpose: its timer is unref'd and must not fire into a later test
    const step = makeDiskReportStep(() => new Promise(() => {}), 60_000);
    assert.equal(step.run(), undefined);
  });

  it('a hung disk report does not hold back the steps around it', async () => {
    const order: string[] = [];
    const steps: BootStep[] = [
      { name: 'before', run: () => void order.push('before') },
      makeDiskReportStep(() => {
        order.push('disk-started');
        return new Promise(() => {});
      }, 60),
      { name: 'scheduler', run: () => void order.push('scheduler') },
    ];

    await runBootTasks(steps);
    assert.deepEqual(order, ['before', 'disk-started', 'scheduler']);
    // the guard has not fired yet: the boot did not wait for it
    assert.equal(lines.some((l) => l.includes('did not finish')), false);

    await sleep(200);
    assert.ok(lines.some((l) => l.includes('did not finish in 60 ms')));
  });

  it('a failing disk report does not stop the boot', async () => {
    let scheduled = false;
    await runBootTasks([
      makeDiskReportStep(() => Promise.reject(new Error('no statfs here')), 5_000),
      { name: 'scheduler', run: () => void (scheduled = true) },
    ]);
    assert.equal(scheduled, true);
    await sleep(20);
    assert.ok(lines.some((l) => l.includes('no statfs here')));
  });
});


describe('boot fetch guard', () => {
  it('serves a fresh cache whether or not the bucket was readable', () => {
    assert.equal(decideBootFetch(true, false), 'serve-cache');
    assert.equal(decideBootFetch(true, true), 'serve-cache');
  });

  it('fetches a stale cache when the bucket state is intact (or mirroring is off)', () => {
    assert.equal(decideBootFetch(false, false), 'fetch');
  });

  it('waits instead of fetching when the cache is stale and the bucket could not be read', () => {
    assert.equal(decideBootFetch(false, true), 'wait-for-bucket');
  });

  it('is the first boot step to touch the cache: storage-sync runs before tle-freshness', () => {
    const names = BOOT_STEPS.map((s) => s.name);
    assert.equal(names[0], 'storage-sync');
    assert.ok(names.indexOf('storage-sync') < names.indexOf('tle-freshness'));
  });
});

describe('mirror recovery', () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** Fake timers: the test fires the scheduled callbacks by hand. */
  function harness(over: Partial<MirrorRecoveryDeps> & { retries?: boolean[]; stale?: boolean[] }) {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let fetches = 0;
    const retries = [...(over.retries ?? [])];
    const stale = [...(over.stale ?? [true])];
    const deps: MirrorRecoveryDeps = {
      delayMs: over.delayMs ?? MIRROR_RECOVERY_DELAY_MS,
      maxAttempts: over.maxAttempts ?? MIRROR_RECOVERY_MAX_ATTEMPTS,
      retry: async () => retries.shift() ?? false,
      cacheFresh: () => !(stale.length > 1 ? stale.shift() : stale[0]),
      fetchNow: () => void (fetches += 1),
      setTimer: (fn, ms) => void timers.push({ fn, ms }),
    };
    return { deps, timers, fetches: () => fetches };
  }

  let lines: string[];
  beforeEach(() => {
    lines = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });
  afterEach(() => mock.restoreAll());

  it('waits 15 minutes, three looks at most', () => {
    assert.equal(MIRROR_RECOVERY_DELAY_MS, 15 * 60_000);
    assert.equal(MIRROR_RECOVERY_MAX_ATTEMPTS, 3);
  });

  it('arms one timer with the configured delay and does nothing until it fires', () => {
    const h = harness({});
    armMirrorRecovery(h.deps);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, MIRROR_RECOVERY_DELAY_MS);
    assert.equal(h.fetches(), 0);
  });

  it('fetches once when the bucket comes back and the restored cache is still stale', async () => {
    const h = harness({ retries: [true], stale: [true] });
    armMirrorRecovery(h.deps);
    h.timers[0].fn();
    await flush();
    assert.equal(h.fetches(), 1);
    assert.equal(h.timers.length, 1, 'no further timer once recovered');
    assert.ok(lines.some((l) => l.includes('recovered')));
  });

  it('does not fetch when the restored cache turns out to be fresh', async () => {
    const h = harness({ retries: [true], stale: [false] });
    armMirrorRecovery(h.deps);
    h.timers[0].fn();
    await flush();
    assert.equal(h.fetches(), 0);
  });

  it('keeps looking while the bucket is down, then fetches as a last resort', async () => {
    const h = harness({ retries: [false, false, false], stale: [true], maxAttempts: 3 });
    armMirrorRecovery(h.deps);
    h.timers[0].fn(); await flush();
    assert.equal(h.timers.length, 2);
    assert.equal(h.fetches(), 0);
    h.timers[1].fn(); await flush();
    assert.equal(h.timers.length, 3);
    assert.equal(h.fetches(), 0);
    h.timers[2].fn(); await flush();
    assert.equal(h.timers.length, 3, 'gave up: no fourth timer');
    assert.equal(h.fetches(), 1);
    assert.ok(lines.some((l) => l.includes('ERROR') && l.includes('still unreadable')));
  });

  it('recovering on the second look stops the loop', async () => {
    const h = harness({ retries: [false, true], stale: [true] });
    armMirrorRecovery(h.deps);
    h.timers[0].fn(); await flush();
    h.timers[1].fn(); await flush();
    assert.equal(h.fetches(), 1);
    assert.equal(h.timers.length, 2);
  });
});
