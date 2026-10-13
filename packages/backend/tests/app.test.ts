// createApp() factory: builds without listening and without boot side effects.
// Uses a real ephemeral port + global fetch (no supertest), injected stub query router.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import { createApp } from '../src/app.js';

describe('createApp', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const stub = Router();
    stub.get('/stub-ping', (_req, res) => { res.json({ stub: true }); });
    const app = createApp({ queryRouter: stub });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /health responds ok', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'ok');
  });

  it('GET /health reports disk usage of the data volume', async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json() as {
      disk: { usedBytes: number; totalBytes: number; percent: number; level: string } | null;
    };
    assert.ok(body.disk, 'expected a disk block (statfs works on the dev machine)');
    assert.ok(body.disk!.totalBytes > 0);
    assert.ok(body.disk!.percent >= 0 && body.disk!.percent <= 100);
    assert.ok(['ok', 'warn', 'critical'].includes(body.disk!.level));
  });

  it('mounts the injected query router under /api/query', async () => {
    const res = await fetch(`${base}/api/query/stub-ping`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stub: true });
  });

  it('unknown /api path 404s (non-production: no catch-all)', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    assert.equal(res.status, 404);
  });
});
