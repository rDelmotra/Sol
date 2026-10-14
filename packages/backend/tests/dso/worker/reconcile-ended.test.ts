// The DSO worker with an ended mission: ask once, remember, stop asking, keep serving
// the stored data. The provider is a fake; the cache dir is a real temp dir.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import type { DsoManifest, DsoSnapshot } from '@orbitwatch/contracts';
import {
  computeLoopDelayMs,
  createDsoWorkerRuntime,
  reconcileDsoWorkerOnce,
  type DsoReconcileDeps,
} from '../../../src/dso/worker/index.ts';
import { DsoEphemerisEndedError } from '../../../src/dso/providers/ended-error.ts';
import { HorizonsNetworkError } from '../../../src/dso/providers/horizons.ts';
import type { DsoProviderAdapter, ProviderFetchResult, ProviderSample } from '../../../src/dso/providers/types.ts';
import type { DsoRegistryEntry } from '../../../src/dso/registry/types.ts';
import { getDsoEndedStatePath, markDsoEnded, readDsoEndedState } from '../../../src/dso/worker/ended-state.ts';
import {
  getDsoManifestPath,
  getDsoSnapshotPath,
  publishDsoSnapshot,
  readDsoManifest,
} from '../../../src/dso/snapshot/index.ts';

const HOUR = 3_600_000;
const ENDED_AT = new Date('2026-04-10T23:54:22.857Z');

// Real registry id (the manifest only keeps registered objects); launch a few days back.
const entry: DsoRegistryEntry = {
  dsoId: 'artemis-ii',
  slug: 'artemis-ii',
  displayName: 'Artemis II',
  provider: 'horizons',
  providerObjectId: '-1024',
  enabled: true,
  targetBody: 'moon',
  regime: 'LUNAR',
  sampleStepSec: 600,
  refreshIntervalSec: 21_600,
  validPastWindowSec: 86_400_000,
  validFutureWindowSec: 21_600,
  mission: 'Artemis II',
  description: null,
  searchAliases: ['artemis'],
  launchDate: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
};

const TDB_MINUS_UTC_DAYS = 69.184 / 86400;

/** Samples every 10 minutes ending an hour ago, inside the worker's window. */
function liveSamples(count = 12): ProviderSample[] {
  const first = Math.floor((Date.now() - HOUR) / 600_000) * 600_000 - (count - 1) * 600_000;
  return Array.from({ length: count }, (_, i) => {
    const utcMs = first + i * 600_000;
    return {
      julianDayTdb: utcMs / 86_400_000 + 2440587.5 + TDB_MINUS_UTC_DAYS,
      calendarTimestampTdb: new Date(utcMs).toISOString().slice(0, 19),
      x: 100_000 + i, y: 200_000, z: 50_000, vx: 0.5, vy: 0.6, vz: 0.1,
    };
  });
}

function fetchResult(coverageEndedAt?: string): ProviderFetchResult {
  return {
    provider: 'horizons',
    providerObjectId: '-1024',
    sourceFrame: 'ICRF',
    sourceUnits: 'KM-S',
    timeScale: 'TDB',
    fetchedAt: new Date().toISOString(),
    sourceRevisionAt: null,
    samples: liveSamples(),
    ...(coverageEndedAt ? { coverageEndedAt } : {}),
  };
}

/** A stored snapshot, as the worker would have published it in April. */
function storedSnapshot(): DsoSnapshot {
  return {
    dsoId: 'artemis-ii',
    snapshotVersion: '2026-04-10T235000Z',
    provider: 'horizons',
    sourceObjectId: '-1024',
    sourceFrame: 'J2000',
    frame: 'TEME',
    distanceUnits: 'earth_radii',
    velocityUnits: 'earth_radii_per_second',
    sampleStepSec: 600,
    fetchedAt: '2026-04-10T23:50:00.000Z',
    sourceRevisionAt: null,
    validFrom: '2026-04-10T22:00:00.000Z',
    validTo: '2026-04-10T22:10:00.000Z',
    freshnessState: 'fresh',
    stateVectors: [
      ['2026-04-10T22:00:00.000Z', 1, 2, 3, 0.1, 0.2, 0.3],
      ['2026-04-10T22:10:00.000Z', 1.1, 2.1, 3.1, 0.1, 0.2, 0.3],
    ],
  } as unknown as DsoSnapshot;
}

describe('DSO worker with an ended mission', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let lines: string[];
  let calls: number;

  function provider(behave: () => Promise<ProviderFetchResult>): DsoProviderAdapter {
    return {
      async fetchEphemeris() {
        calls += 1;
        return behave();
      },
    };
  }

  function deps(p: DsoProviderAdapter, over: Partial<DsoReconcileDeps> = {}): DsoReconcileDeps {
    return { entries: [entry], getProvider: () => p, runtime: createDsoWorkerRuntime(), retryEnded: false, ...over };
  }

  const throwEnded = () => Promise.reject(new DsoEphemerisEndedError('ephemeris ended', ENDED_AT));
  const endedLines = () => lines.filter((l) => l.includes('ephemeris ended') && l.includes('keeping stored data'));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dso-reconcile-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    lines = [];
    calls = 0;
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

  it('an ended answer is remembered, logged as INFO (not ERROR), and costs no failure', async () => {
    const d = deps(provider(throwEnded));
    const manifest = await reconcileDsoWorkerOnce(new Date(), d);

    assert.equal(calls, 1);
    assert.equal(manifest.objects['artemis-ii'].failureCount, 0);
    assert.equal(manifest.objects['artemis-ii'].lastFailureAt, null);
    assert.equal(lines.filter((l) => l.includes('ERROR')).length, 0);
    assert.equal(endedLines().length, 1);
    assert.ok(endedLines()[0].includes('INFO'));
    assert.ok(endedLines()[0].includes('2026-04-10T23:54:22.857Z'));
    assert.equal((await readDsoEndedState()).objects['artemis-ii'].endedAt, ENDED_AT.toISOString());
  });

  it('after that, refresh attempts are skipped and the line appears once per boot', async () => {
    const d = deps(provider(throwEnded));
    await reconcileDsoWorkerOnce(new Date(), d);
    const refreshLinesAfterFirst = lines.filter((l) => l.includes('DSO refresh')).length;

    for (let i = 0; i < 4; i++) await reconcileDsoWorkerOnce(new Date(Date.now() + i * 7 * HOUR), d);
    assert.equal(calls, 1, 'the provider is never asked again');
    assert.equal(lines.filter((l) => l.includes('DSO refresh')).length, refreshLinesAfterFirst);
    assert.equal(endedLines().length, 1, 'a single INFO line for the whole boot, detection included');
  });

  it('a restart (new runtime, same volume) skips the provider and logs once more', async () => {
    await reconcileDsoWorkerOnce(new Date(), deps(provider(throwEnded)));
    lines.length = 0;

    const restarted = deps(provider(throwEnded)); // fresh runtime
    await reconcileDsoWorkerOnce(new Date(), restarted);
    await reconcileDsoWorkerOnce(new Date(), restarted);
    assert.equal(calls, 1);
    assert.equal(endedLines().length, 1);
  });

  it('stored data is untouched: snapshot bytes and object status are identical', async () => {
    await publishDsoSnapshot(entry, storedSnapshot(), null, new Date().toISOString());
    const snapshotFile = getDsoSnapshotPath('artemis-ii', '2026-04-10T235000Z');
    const bytesBefore = fs.readFileSync(snapshotFile);
    const statusBefore = ((await readDsoManifest()) as DsoManifest).objects['artemis-ii'];
    assert.equal(statusBefore.currentSnapshotVersion, '2026-04-10T235000Z');

    const d = deps(provider(throwEnded));
    await reconcileDsoWorkerOnce(new Date(Date.now() + 30 * HOUR), d); // due: finds it ended
    await reconcileDsoWorkerOnce(new Date(Date.now() + 60 * HOUR), d);
    await reconcileDsoWorkerOnce(new Date(Date.now() + 90 * HOUR), d);

    assert.deepEqual(fs.readFileSync(snapshotFile), bytesBefore);
    const statusAfter = ((await readDsoManifest()) as DsoManifest).objects['artemis-ii'];
    assert.deepEqual(statusAfter, statusBefore);
    assert.deepEqual(fs.readdirSync(path.dirname(snapshotFile)), ['2026-04-10T235000Z.json']);
  });

  it('a successful clamped fetch publishes the final snapshot, marks the mission ended, then stops', async () => {
    const d = deps(provider(async () => fetchResult(ENDED_AT.toISOString())));
    const first = await reconcileDsoWorkerOnce(new Date(), d);
    assert.equal(calls, 1);
    assert.equal(first.objects['artemis-ii'].availability, true);
    assert.ok(first.objects['artemis-ii'].currentSnapshotVersion);
    assert.equal((await readDsoEndedState()).objects['artemis-ii'].endedAt, ENDED_AT.toISOString());

    await reconcileDsoWorkerOnce(new Date(Date.now() + 48 * HOUR), d);
    assert.equal(calls, 1, 'no more attempts after the final snapshot');
    const manifest = (await readDsoManifest()) as DsoManifest;
    assert.equal(manifest.objects['artemis-ii'].currentSnapshotVersion, first.objects['artemis-ii'].currentSnapshotVersion);
  });

  it('a live mission is unaffected: success leaves no ended state', async () => {
    const d = deps(provider(async () => fetchResult()));
    await reconcileDsoWorkerOnce(new Date(), d);
    assert.equal(calls, 1);
    assert.deepEqual(await readDsoEndedState(), { objects: {} });
    assert.equal(fs.existsSync(getDsoEndedStatePath()), false);
  });

  it('an ordinary failure still records a failure and an ERROR (no ended state)', async () => {
    const d = deps(provider(() => Promise.reject(new HorizonsNetworkError('Horizons request failed (network/timeout)'))));
    const manifest = await reconcileDsoWorkerOnce(new Date(), d);
    assert.equal(manifest.objects['artemis-ii'].failureCount, 1);
    assert.equal(lines.filter((l) => l.includes('ERROR') && l.includes('DSO refresh failed')).length, 1);
    assert.deepEqual(await readDsoEndedState(), { objects: {} });
  });

  it('if the ended flag cannot be saved, it is a normal failure (nothing silently lost)', async () => {
    fs.mkdirSync(getDsoEndedStatePath(), { recursive: true }); // unwritable
    const d = deps(provider(throwEnded));
    const manifest = await reconcileDsoWorkerOnce(new Date(), d);
    assert.equal(manifest.objects['artemis-ii'].failureCount, 1);
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('ended-state could not be saved')));
    assert.ok(lines.some((l) => l.includes('ERROR') && l.includes('DSO refresh failed')));
  });

  it('a corrupt state file behaves like before: the object is refreshed', async () => {
    fs.mkdirSync(path.dirname(getDsoEndedStatePath()), { recursive: true });
    fs.writeFileSync(getDsoEndedStatePath(), 'not json', 'utf8');
    await reconcileDsoWorkerOnce(new Date(), deps(provider(async () => fetchResult())));
    assert.equal(calls, 1);
  });

  describe('DSO_RETRY_ENDED', () => {
    it('retries an ended object once per boot, not every cycle', async () => {
      await markDsoEnded('artemis-ii', ENDED_AT);
      const d = deps(provider(throwEnded), { retryEnded: true });

      await reconcileDsoWorkerOnce(new Date(), d);
      await reconcileDsoWorkerOnce(new Date(Date.now() + 7 * HOUR), d);
      await reconcileDsoWorkerOnce(new Date(Date.now() + 14 * HOUR), d);
      assert.equal(calls, 1);
      assert.ok(lines.some((l) => l.includes('DSO_RETRY_ENDED is set')));
      assert.equal(endedLines().length, 1);

      // next boot: one more try
      await reconcileDsoWorkerOnce(new Date(), deps(provider(throwEnded), { retryEnded: true }));
      assert.equal(calls, 2);
    });

    it('new data found: the ended flag is cleared and refreshes resume', async () => {
      await markDsoEnded('artemis-ii', ENDED_AT);
      const d = deps(provider(async () => fetchResult()), { retryEnded: true });

      await reconcileDsoWorkerOnce(new Date(), d);
      assert.equal(calls, 1);
      assert.deepEqual(await readDsoEndedState(), { objects: {} });
      assert.ok(lines.some((l) => l.includes('ended flag cleared')));

      // a normal (not forced) boot now refreshes it when due
      await reconcileDsoWorkerOnce(new Date(Date.now() + 7 * HOUR), deps(provider(async () => fetchResult())));
      assert.equal(calls, 2);
    });

    it('still ended: the flag stays and a network error on the retry does not clear it', async () => {
      await markDsoEnded('artemis-ii', ENDED_AT);
      const d = deps(provider(() => Promise.reject(new HorizonsNetworkError('timeout'))), { retryEnded: true });
      await reconcileDsoWorkerOnce(new Date(), d);
      assert.ok((await readDsoEndedState()).objects['artemis-ii']);
    });

    it('reads DSO_RETRY_ENDED from the environment when retryEnded is not injected', async () => {
      await markDsoEnded('artemis-ii', ENDED_AT);
      const prev = process.env.DSO_RETRY_ENDED;
      process.env.DSO_RETRY_ENDED = '1';
      try {
        const d = deps(provider(throwEnded));
        delete d.retryEnded;
        await reconcileDsoWorkerOnce(new Date(), d);
        assert.equal(calls, 1);
      } finally {
        if (prev === undefined) delete process.env.DSO_RETRY_ENDED;
        else process.env.DSO_RETRY_ENDED = prev;
      }
    });
  });
});

describe('computeLoopDelayMs with ended objects', () => {
  const failedNoSnapshot: DsoManifest = {
    generatedAt: '2026-10-14T00:00:00.000Z',
    workerLastRunAt: '2026-10-14T00:00:00.000Z',
    objects: {
      'artemis-ii': {
        enabled: true, provider: 'horizons', providerObjectId: '-1024',
        currentSnapshotVersion: null, freshnessState: 'unavailable',
        validFrom: null, validTo: null, lastSuccessAt: null,
        lastFailureAt: '2026-10-14T00:00:00.000Z', failureCount: 12,
        availability: false, snapshotPath: null,
      },
    },
  };
  const now = new Date('2026-10-14T00:10:00.000Z');

  it('an object waiting for a retry shortens the sleep (as before)', () => {
    const delay = computeLoopDelayMs([entry], failedNoSnapshot, now);
    assert.ok(delay <= 30 * 60_000, `delay ${delay}`);
  });

  it('an ended object does not: the worker sleeps a normal refresh interval', () => {
    const delay = computeLoopDelayMs([entry], failedNoSnapshot, now, new Set(['artemis-ii']));
    assert.ok(delay >= 21_600_000 * 0.9 && delay <= 21_600_000 * 1.1, `delay ${delay}`);
  });
});
