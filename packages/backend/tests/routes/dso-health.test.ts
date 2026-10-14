// /health and the DSO ended state: a finished mission is reported as ended, not fresh.
// Pure counting first, then the real route with a temp CACHE_DIR.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { Router } from 'express';
import type { DsoManifest, DsoObjectStatus, DsoSnapshot } from '@orbitwatch/contracts';
import { createApp } from '../../src/app.js';
import { summarizeDsoHealth } from '../../src/routes/dso.js';
import { getDsoRegistryEntry } from '../../src/dso/registry/index.js';
import { publishDsoSnapshot } from '../../src/dso/snapshot/index.js';
import { clearDsoEnded, getDsoEndedStatePath, markDsoEnded } from '../../src/dso/worker/ended-state.js';

const ID = 'artemis-ii';

function manifestWith(status: Partial<DsoObjectStatus>): DsoManifest {
  return {
    generatedAt: '2026-10-14T00:00:00.000Z',
    workerLastRunAt: '2026-10-14T00:00:00.000Z',
    objects: {
      [ID]: {
        enabled: true,
        provider: 'horizons',
        providerObjectId: '-1024',
        currentSnapshotVersion: '2026-04-10T235000Z',
        freshnessState: 'fresh',
        validFrom: '2026-04-02T00:00:00.000Z',
        validTo: '2026-04-10T00:00:00.000Z',
        lastSuccessAt: '2026-04-10T23:50:00.000Z',
        lastFailureAt: null,
        failureCount: 0,
        availability: true,
        snapshotPath: 'snapshots/artemis-ii/2026-04-10T235000Z.json',
        ...status,
      },
    },
  };
}

describe('summarizeDsoHealth', () => {
  const ended = new Set([ID]);

  it('without an ended object it counts exactly as before', () => {
    const fresh = summarizeDsoHealth(manifestWith({}));
    assert.equal(fresh.dsoEnabledCount, 1);
    assert.equal(fresh.dsoFreshCount, 1);
    assert.equal(fresh.dsoEndedCount, 0);

    assert.equal(summarizeDsoHealth(manifestWith({ freshnessState: 'stale' })).dsoStaleCount, 1);
    assert.equal(summarizeDsoHealth(manifestWith({ freshnessState: 'degraded' })).dsoDegradedCount, 1);
    assert.equal(summarizeDsoHealth(null).dsoUnavailableCount, 1);
  });

  it('an ended object with its ephemeris on disk is ended, not fresh', () => {
    const s = summarizeDsoHealth(manifestWith({}), ended);
    assert.equal(s.dsoEndedCount, 1);
    assert.equal(s.dsoFreshCount, 0);
  });

  it('ended wins over a stale or degraded manifest state (a finished mission is not broken)', () => {
    for (const freshnessState of ['stale', 'degraded'] as const) {
      const s = summarizeDsoHealth(manifestWith({ freshnessState }), ended);
      assert.equal(s.dsoEndedCount, 1, freshnessState);
      assert.equal(s.dsoStaleCount + s.dsoDegradedCount, 0, freshnessState);
    }
  });

  it('an ended object with nothing stored is still unavailable', () => {
    const s = summarizeDsoHealth(
      manifestWith({ currentSnapshotVersion: null, freshnessState: 'unavailable', availability: false }),
      ended,
    );
    assert.equal(s.dsoEndedCount, 0);
    assert.equal(s.dsoUnavailableCount, 1);
  });

  it('ended ids of objects that are not enabled are ignored', () => {
    const s = summarizeDsoHealth(manifestWith({}), new Set(['some-other-mission']));
    assert.equal(s.dsoEndedCount, 0);
    assert.equal(s.dsoFreshCount, 1);
  });

  it('every enabled object lands in exactly one bucket', () => {
    for (const endedIds of [new Set<string>(), ended]) {
      const s = summarizeDsoHealth(manifestWith({}), endedIds);
      assert.equal(
        s.dsoFreshCount + s.dsoStaleCount + s.dsoDegradedCount + s.dsoUnavailableCount + s.dsoEndedCount,
        s.dsoEnabledCount,
      );
    }
  });
});

describe('GET /health with an ended DSO — real route, temp CACHE_DIR', () => {
  let server: Server;
  let base: string;
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let lines: string[];

  type Health = {
    dsoEnabledCount: number;
    dsoFreshCount: number;
    dsoEndedCount: number;
    dsoUnavailableCount: number;
  };
  const health = async (): Promise<Health> => (await fetch(`${base}/health`)).json() as Promise<Health>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dso-health-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;

    const stub = Router();
    const app = createApp({ queryRouter: stub });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // one stored snapshot, as the worker would have published it
    const snapshot = {
      dsoId: ID,
      snapshotVersion: '2026-04-10T235000Z',
      fetchedAt: new Date().toISOString(),
      validFrom: '2026-04-02T00:00:00.000Z',
      validTo: '2026-04-10T00:00:00.000Z',
      stateVectors: [],
    } as unknown as DsoSnapshot;
    await publishDsoSnapshot(getDsoRegistryEntry(ID)!, snapshot, null, new Date().toISOString());
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    lines = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    mock.method(console, 'warn', capture);
  });

  afterEach(() => {
    fs.rmSync(getDsoEndedStatePath(), { force: true });
    mock.restoreAll();
  });

  it('not ended: the object is fresh', async () => {
    const body = await health();
    assert.equal(body.dsoEnabledCount, 1);
    assert.equal(body.dsoFreshCount, 1);
    assert.equal(body.dsoEndedCount, 0);
  });

  it('ended: the same object is reported as ended, and back to fresh once the flag is cleared', async () => {
    await markDsoEnded(ID, '2026-04-10T23:54:22.857Z');
    const ended = await health();
    assert.equal(ended.dsoEndedCount, 1);
    assert.equal(ended.dsoFreshCount, 0);

    await clearDsoEnded(ID);
    const back = await health();
    assert.equal(back.dsoEndedCount, 0);
    assert.equal(back.dsoFreshCount, 1);
  });

  it('a corrupt ended.json does not break /health and does not flood the log', async () => {
    fs.writeFileSync(getDsoEndedStatePath(), '{{{', 'utf8');
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Health;
    assert.equal(body.dsoEndedCount, 0);
    assert.equal(lines.filter((l) => l.includes('ended-state')).length, 0);
  });
});
