// /api/ssa/passes and /api/ssa/regions: validation (400), availability (503), the response shape, cache headers and ETag, with the
// query itself replaced by a fake (the real one is tested in passes-query.test.ts).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Pool } from 'pg';
import { createSsaPassesRouter, createSsaRegionsRouter } from '../../src/routes/ssa-passes.js';
import { REGIONS, PassesError, GUARANTEE, type PassesResultWithIds } from '../../src/ssa/passes/index.js';
import { SSA_PASS_REGION_IDS, SSA_PASS_MAX_WINDOW_DAYS, type SsaPassesResponse, type SsaRegionsResponse } from '@orbitwatch/contracts';
import { createApp } from '../../src/app.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const stats = { days: 3, candidateObjectDays: 10, refinedObjectDays: 8, wallS: 1.5, coverS: 0, loadS: 0, refineS: 0 };

interface Call { region: string; fromMs: number; toMs: number; opts: Record<string, unknown> }
async function serve(opts: { db: Pool | null; passes?: (c: Call) => Promise<PassesResultWithIds> }): Promise<{ server: Server; base: string; calls: Call[] }> {
  const calls: Call[] = [];
  const router = createSsaPassesRouter({
    getDb: () => opts.db,
    now: () => NOW,
    passes: async (_p, region, fromMs, toMs, o) => {
      const c = { region: region.id, fromMs, toMs, opts: o as Record<string, unknown> }; calls.push(c);
      if (opts.passes) return opts.passes(c);
      return { fromMs, toMs, clippedToNow: false, totalObjects: 3, objects: [{ noradId: 25544, passes: [[fromMs + 1000, fromMs + 61_000], [fromMs + 5_000_000, fromMs + 5_100_000]] }, { noradId: 40000, passes: [] }], missingDays: ['2026-10-09'], filledDays: [], layers: {}, stats, allIds: [25544, 40000, 50000] };
    },
    names: async () => new Map([[25544, 'ISS (ZARYA)']]),
  });
  const app = express();
  app.use('/api/ssa/passes', router);
  app.use('/api/ssa/regions', createSsaRegionsRouter());
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ssa`, calls };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
const fakeDb = {} as Pool;

describe('ssa passes routes: validation and availability', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  before(async () => { s = await serve({ db: null }); });
  after(() => close(s.server));

  const bad = [
    '/passes', // no region
    '/passes?region=india', // no from
    '/passes?region=atlantis&from=2026-10-01',
    '/passes?region=india&lat=10&from=2026-10-01',
    '/passes?lat=10&lon=20&from=2026-10-01', // no radius
    '/passes?lat=10&lon=20&radiusKm=2&from=2026-10-01',
    '/passes?lat=10&lon=20&radiusKm=99999&from=2026-10-01',
    '/passes?lat=95&lon=20&radiusKm=100&from=2026-10-01',
    '/passes?lat=88&lon=20&radiusKm=500&from=2026-10-01', // too close to the pole
    '/passes?region=india&from=nope',
    '/passes?region=india&from=2026-10-01&to=2026-13-45',
    '/passes?region=india&from=2026-10-10&to=2026-10-01', // from after to
    '/passes?region=india&from=2026-10-10&to=2026-10-10',
    '/passes?region=india&from=2026-06-01', // more than 90 days
    '/passes?region=india&from=2026-10-01&norad=abc',
    '/passes?region=india&from=2026-10-01&norad=0',
    '/passes?region=india&from=2026-10-01&limit=201',
    '/passes?region=india&from=2026-10-01&limit=-1',
    '/passes?region=india&from=2026-10-01&fill=maybe',
    '/passes?region=india&region=japan&from=2026-10-01',
  ];
  for (const q of bad) {
    it(`400 ${q}`, async () => {
      const r = await fetch(s.base + q);
      assert.equal(r.status, 400, q);
      assert.equal(typeof ((await r.json()) as { error: string }).error, 'string');
    });
  }
  it('503 when history is unavailable (valid query)', async () => {
    const r = await fetch(`${s.base}/passes?region=india&from=2026-10-10`);
    assert.equal(r.status, 503);
  });
  it('400 beats 503', async () => { assert.equal((await fetch(`${s.base}/passes?region=nope&from=2026-10-10`)).status, 400); });
  it('the regions list needs no database', async () => {
    const r = await fetch(`${s.base}/regions`);
    assert.equal(r.status, 200);
    const b = (await r.json()) as SsaRegionsResponse;
    assert.deepEqual(b.regions.map((x) => x.id), [...SSA_PASS_REGION_IDS]);
    assert.equal(b.regions.find((x) => x.id === 'india')!.approximate, false);
    assert.ok(b.regions.filter((x) => x.id !== 'india').every((x) => x.approximate));
    assert.equal(b.maxWindowDays, SSA_PASS_MAX_WINDOW_DAYS);
    assert.deepEqual(REGIONS.map((x) => x.id), [...SSA_PASS_REGION_IDS]);
  });
});

describe('ssa passes routes: answers', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  before(async () => { s = await serve({ db: fakeDb }); });
  after(() => close(s.server));

  it('named region: shape, names, ISO times, guarantee, missing days, past-window cache header', async () => {
    const r = await fetch(`${s.base}/passes?region=India&from=2026-10-10&to=2026-10-14`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=60'); // a missing day in the window: not settled
    const b = (await r.json()) as SsaPassesResponse;
    assert.equal(b.region.id, 'india');
    assert.equal(b.from, '2026-10-10T00:00:00.000Z');
    assert.equal(b.totalObjects, 3);
    assert.deepEqual(b.missingDays, ['2026-10-09']);
    assert.equal(b.guarantee, GUARANTEE);
    assert.match(b.guarantee, /10-second/);
    assert.deepEqual(b.objects[0], { noradId: 25544, name: 'ISS (ZARYA)', count: 2, passes: [{ start: '2026-10-10T00:00:01.000Z', end: '2026-10-10T00:01:01.000Z' }, { start: '2026-10-10T01:23:20.000Z', end: '2026-10-10T01:25:00.000Z' }] });
    assert.equal(b.objects[1]!.name, null);
    assert.equal(s.calls.at(-1)!.region, 'india');
    assert.equal(s.calls.at(-1)!.opts.limit, 50);
  });

  it('circle query, norad, limit and fill are passed through; a bare date is UTC midnight; `to` defaults to now', async () => {
    await fetch(`${s.base}/passes?lat=48.8566&lon=2.3522&radiusKm=500&from=2026-10-19T06:00:00Z&norad=25544&limit=0&fill=1`);
    const c = s.calls.at(-1)!;
    assert.equal(c.region, 'circle:48.8566,2.3522,500');
    assert.equal(c.fromMs, Date.parse('2026-10-19T06:00:00Z'));
    assert.equal(c.toMs, NOW);
    assert.deepEqual([c.opts.norad, c.opts.limit, c.opts.fill], [25544, 0, true]);
  });

  it('a settled past window is cacheable for an hour and answers 304 to its ETag', async () => {
    const empty = await serve({ db: fakeDb, passes: async (c) => ({ fromMs: c.fromMs, toMs: c.toMs, clippedToNow: false, totalObjects: 0, objects: [], missingDays: [], filledDays: [], layers: {}, stats }) });
    try {
      const url = `${empty.base}/passes?region=japan&from=2026-10-10&to=2026-10-12`;
      const r1 = await fetch(url);
      assert.equal(r1.headers.get('cache-control'), 'public, max-age=3600');
      const etag = r1.headers.get('etag')!;
      assert.ok(etag);
      assert.equal((await fetch(url, { headers: { 'if-none-match': etag } })).status, 304);
      // window up to now: short cache
      assert.equal((await fetch(`${empty.base}/passes?region=japan&from=2026-10-10`)).headers.get('cache-control'), 'public, max-age=60');
    } finally { await close(empty.server); }
  });

  it('a busy server answers 429 with Retry-After; an unexpected failure 503', async () => {
    const busy = await serve({ db: fakeDb, passes: async () => { throw new PassesError('busy', 'too many'); } });
    const boom = await serve({ db: fakeDb, passes: async () => { throw new Error('disk gone'); } });
    try {
      const r = await fetch(`${busy.base}/passes?region=india&from=2026-10-10`);
      assert.equal(r.status, 429); assert.ok(r.headers.get('retry-after'));
      assert.equal((await fetch(`${boom.base}/passes?region=india&from=2026-10-10`)).status, 503);
    } finally { await close(busy.server); await close(boom.server); }
  });
});

describe('ssa passes routes: mounted in the app', () => {
  it('/api/ssa/regions answers and /api/ssa/passes validates through createApp', async () => {
    const app = createApp({ queryRouter: express.Router() });
    const server = await new Promise<Server>((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      assert.equal((await fetch(`${base}/api/ssa/regions`)).status, 200);
      assert.equal((await fetch(`${base}/api/ssa/passes?region=india`)).status, 400);
      assert.equal((await fetch(`${base}/api/ssa/passes?region=india&from=2026-10-01`)).status, 503); // no history in this test
    } finally { await close(server); }
  });
});
