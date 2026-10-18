// DSO isolation on the API side: a missing, empty, corrupt or unreadable DSO data
// directory must never break /health, other routes, or crash the process.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { Router } from 'express';
import { createApp } from '../../src/app.js';
import { readDsoHealth, withDsoTimeout } from '../../src/routes/dso.js';

const ID = 'artemis-ii';

describe('DSO isolation — real app, temp CACHE_DIR', () => {
  let server: Server;
  let base: string;
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let dsoDir: string;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => void rejections.push(reason);

  const get = (p: string) => fetch(`${base}${p}`);

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dso-isolation-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
    dsoDir = path.join(tmpDir, 'dso');
    process.on('unhandledRejection', onRejection);
    const app = createApp({ queryRouter: Router() });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    process.off('unhandledRejection', onRejection);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    rejections.length = 0;
    fs.rmSync(dsoDir, { recursive: true, force: true });
    mock.method(console, 'warn', () => undefined);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  const write = (name: string, text: string): void => {
    fs.mkdirSync(dsoDir, { recursive: true });
    fs.writeFileSync(path.join(dsoDir, name), text, 'utf8');
  };

  const settle = () => new Promise<void>((r) => setImmediate(r));

  it('missing DSO directory: /health is 200 with zero DSO counts, DSO routes are 503, no rejection', async () => {
    const h = await get('/health');
    assert.equal(h.status, 200);
    const body = (await h.json()) as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.equal(body.dsoFreshCount, 0);
    assert.equal(body.dsoError, undefined); // missing is normal, not an error

    for (const p of ['/api/dso/catalog', '/api/dso/manifest', `/api/dso/ephemeris/${ID}`]) {
      assert.equal((await get(p)).status, 503, p);
    }
    assert.equal((await get('/api/dso/ephemeris/nope')).status, 404);
    await settle();
    assert.deepEqual(rejections, []);
  });

  it('corrupt manifest: /health 200 with dsoError, DSO routes fast 503 JSON', async () => {
    write('manifest.json', '{{{ not json');
    write('catalog.json', '<<<');
    const h = await get('/health');
    assert.equal(h.status, 200);
    const body = (await h.json()) as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.equal(body.dsoError, true);
    assert.equal(body.dsoFreshCount, 0);
    assert.equal(body.dsoEnabledCount, 0);
    assert.equal(body.dsoWorkerLastRunAt, null);

    for (const p of ['/api/dso/catalog', '/api/dso/manifest', `/api/dso/ephemeris/${ID}`]) {
      const res = await get(p);
      assert.equal(res.status, 503, p);
      assert.match(res.headers.get('content-type') ?? '', /json/);
      assert.ok(((await res.json()) as { error: string }).error);
    }
    await settle();
    assert.deepEqual(rejections, []);
  });

  it('manifest with the wrong shape (valid JSON): no crash anywhere', async () => {
    for (const text of ['[]', '{}', '42', '{"objects":5}']) {
      write('manifest.json', text);
      assert.equal((await get('/health')).status, 200, text);
      for (const p of ['/api/dso/manifest', `/api/dso/ephemeris/${ID}`]) {
        const res = await get(p);
        assert.equal(res.status, 503, `${p} with ${text}`);
      }
    }
    write('manifest.json', 'null'); // valid JSON, means "no manifest"
    assert.equal((await get('/health')).status, 200);
    assert.equal((await get('/api/dso/manifest')).status, 503);
    await settle();
    assert.deepEqual(rejections, []);
  });

  it('manifest points at a corrupt snapshot: ephemeris is a 503', async () => {
    write('manifest.json', JSON.stringify({
      generatedAt: '2026-10-14T00:00:00.000Z',
      workerLastRunAt: null,
      objects: { [ID]: { currentSnapshotVersion: 'v1', freshnessState: 'fresh' } },
    }));
    fs.mkdirSync(path.join(dsoDir, 'snapshots', ID), { recursive: true });
    fs.writeFileSync(path.join(dsoDir, 'snapshots', ID, 'v1.json'), '{{{', 'utf8');
    assert.equal((await get(`/api/dso/ephemeris/${ID}`)).status, 503);
    assert.equal((await get('/health')).status, 200);
    await settle();
    assert.deepEqual(rejections, []);
  });

  it('unreadable manifest (a directory where the file should be): still 200 / 503', async () => {
    fs.mkdirSync(path.join(dsoDir, 'manifest.json'), { recursive: true });
    const h = await get('/health');
    assert.equal(h.status, 200);
    assert.equal(((await h.json()) as { dsoError?: boolean }).dsoError, true);
    assert.equal((await get('/api/dso/manifest')).status, 503);
  });

  it('the rest of the API keeps answering while the DSO data is corrupt', async () => {
    write('manifest.json', 'garbage');
    assert.equal((await get('/health')).status, 200);
    const res = await get('/api/tle/all');
    assert.ok(res.status < 600);
    // not a crash: the server still answers afterwards
    assert.equal((await get('/health')).status, 200);
  });
});

describe('readDsoHealth / withDsoTimeout', () => {
  it('withDsoTimeout rejects a read that never finishes', async () => {
    await assert.rejects(withDsoTimeout(new Promise(() => undefined), 20), /timed out/);
  });

  it('withDsoTimeout passes a result through', async () => {
    assert.equal(await withDsoTimeout(Promise.resolve(7), 20), 7);
  });

  it('readDsoHealth never throws and has no dsoError on an empty data dir', async () => {
    const prev = process.env.CACHE_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dso-health-empty-'));
    process.env.CACHE_DIR = dir;
    try {
      const h = await readDsoHealth();
      assert.equal(h.dsoError, undefined);
      assert.equal(h.dsoFreshCount, 0);
    } finally {
      if (prev === undefined) delete process.env.CACHE_DIR;
      else process.env.CACHE_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
