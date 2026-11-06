// /api/history/{range,catalog,timeline}: validation (400 before anything else), 503 (no root / missing root / no database), the
// shape, cache headers + ETag + 304, gzip and identity, the catalog of a day equals the build path (coverage manifest: same objects,
// same sets, same propagators), the disk cache, the timeline SQL (buckets, kinds, window).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Pool } from 'pg';
import type { HistoryCatalog, HistoryRange, HistoryTimelineBucket } from '@orbitwatch/contracts';
import { createHistoryApiRouter, parseTimelineQuery, bucketCount } from '../../src/routes/history.js';
import { clearHistoryStores, getHistoryStore } from '../../src/ssa/history/store.js';
import { catalogAsOfDay } from '../../src/ssa/history/catalog-files.js';
import { loadObjects } from '../../src/ssa/history/elset-files.js';
import { eraFor } from '../../src/ssa/history/era.js';
import { readManifest } from '../../src/ssa/coverage/store.js';
import { createTestDb, DB_URL } from './db-helper.js';
import { buildTestRoot } from './history-root.js';
import { D0, D1 } from './history-helpers.js';

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
async function serve(opts: { root: string | import('../../src/ssa/config.js').HistoryPaths | null; db?: Pick<Pool, 'query'> | null }): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use('/api/history', createHistoryApiRouter({ root: () => opts.root, getDb: () => opts.db ?? null, now: () => Date.parse('2026-11-01T00:00:00Z') }));
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/history` };
}

const tr = buildTestRoot();
test.after(() => { clearHistoryStores(); tr.cleanup(); });

test('validation is a 400 before the availability check', async () => {
  const s = await serve({ root: null });
  try {
    const bad = [
      '/catalog', '/catalog?day=', '/catalog?day=2026-02-30', '/catalog?day=26-10-12', '/catalog?day=2026-10-12&day=2026-10-13', '/catalog?day=2026-10-12T00:00',
      '/timeline?from=nope', '/timeline?to=2026-13-01', '/timeline?from=2026-05-01&to=2026-04-01', '/timeline?bucket=week', '/timeline?bucket=day&bucket=month',
      '/timeline?kinds=', '/timeline?kinds=a b', '/timeline?kinds=' + 'k,'.repeat(20) + 'z', '/timeline?kinds=1abc',
    ];
    for (const p of bad) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 400, p);
      assert.equal(typeof ((await r.json()) as { error: string }).error, 'string', p);
    }
  } finally { await close(s.server); }
});

test('503 without SSA_HISTORY_DIR, with a missing directory, and for the timeline without a database', async () => {
  for (const root of [null, join(tmpdir(), 'no-such-history-dir')]) {
    const s = await serve({ root });
    try {
      for (const p of ['/range', '/catalog?day=2026-10-12', '/timeline']) {
        const r = await fetch(s.base + p);
        assert.equal(r.status, 503, `${root} ${p}`);
        assert.ok(((await r.json()) as { error: string }).error);
      }
    } finally { await close(s.server); }
  }
  const s = await serve({ root: tr.root, db: null });
  try {
    assert.equal((await fetch(s.base + '/timeline')).status, 503);
    assert.equal((await fetch(s.base + '/range')).status, 200);
  } finally { await close(s.server); }
});

test('range', async () => {
  clearHistoryStores();
  const s = await serve({ root: tr.root });
  try {
    const r = await fetch(s.base + '/range');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control')!, /public, max-age=\d+/);
    const b = (await r.json()) as HistoryRange;
    assert.deepEqual(b, { firstDay: '1965-06-05', lastDay: D1, days: 4, eventsFirstDay: '1965-06-05', eventsLastDay: D1, hasCoverage: true });
  } finally { await close(s.server); }
});

test('catalog: the build path\'s objects and sets, accuracy and propagator by era, long cache headers, ETag / 304, gzip and identity', async () => {
  clearHistoryStores();
  const s = await serve({ root: tr.root });
  try {
    const objects = loadObjects(join(tr.root, 'objects.jsonl.gz'));
    for (const day of [D0, D1, '1965-06-06']) {
      const r = await fetch(`${s.base}/catalog?day=${day}`);
      assert.equal(r.status, 200, day);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=604800');
      assert.match(r.headers.get('content-type')!, /application\/json/);
      assert.equal(r.headers.get('content-encoding'), 'gzip');
      const body = (await r.json()) as HistoryCatalog;
      assert.equal(body.day, day);
      // the day's coverage manifest lists exactly these objects (index order = ascending NORAD id) and the SGP ones
      const m = readManifest(join(tr.root, 'coverage'), day)!;
      assert.deepEqual(body.objects.map((o) => o.noradId), m.norad, day);
      assert.deepEqual(body.objects.filter((o) => o.propagator === 'sgp').map((o) => o.noradId), m.propagators?.sgp ?? [], day);
      // ... and each object carries the set the file catalog gives from scratch
      const era = eraFor(day);
      const scratch = catalogAsOfDay(join(tr.root, 'elsets'), objects, day, era.windowDays);
      assert.deepEqual(body.objects.map((o) => o.omm), scratch.map((o) => o.omm), day);
      assert.deepEqual(body.accuracy, era.accuracy ? { medianKm: era.accuracy.medianKm, p95Km: era.accuracy.p95Km } : null);
      for (const o of body.objects) {
        assert.ok(['sgp4', 'sgp'].includes(o.propagator));
        for (const k of ['MEAN_MOTION_DDOT', 'EPHEMERIS_TYPE', 'MEAN_MOTION_DOT', 'BSTAR', 'EPOCH', 'NORAD_CAT_ID']) assert.ok(k in o.omm, `${k} in omm`);
        assert.equal(o.objectType, objects.get(o.noradId)?.objectType ?? 'unknown');
      }
    }
    const d1 = (await (await fetch(`${s.base}/catalog?day=${D1}`)).json()) as HistoryCatalog;
    assert.equal(d1.accuracy, null);
    assert.ok(d1.objects.every((o) => o.propagator === 'sgp4'));
    assert.ok(d1.objects.some((o) => o.noradId === 200) && !d1.objects.some((o) => o.noradId === 150 || o.noradId === 400), 'appeared / stale / decayed objects as of the day');
    const old = (await (await fetch(`${s.base}/catalog?day=1965-06-06`)).json()) as HistoryCatalog;
    assert.deepEqual(old.accuracy, { medianKm: 79, p95Km: 808 });
    assert.equal(old.objects.length, 12);
    assert.ok(old.objects.every((o) => o.propagator === 'sgp'), 'B* = 0 sets of 1965 are SGP');

    // ETag and 304
    const r1 = await fetch(`${s.base}/catalog?day=${D1}`);
    const etag = r1.headers.get('etag')!;
    assert.ok(etag);
    await r1.arrayBuffer();
    const r2 = await fetch(`${s.base}/catalog?day=${D1}`, { headers: { 'if-none-match': etag } });
    assert.equal(r2.status, 304);
    // identity: same JSON, no content-encoding
    const r3 = await fetch(`${s.base}/catalog?day=${D1}`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(r3.headers.get('content-encoding'), null);
    assert.deepEqual(await r3.json(), d1);
    // outside the data
    for (const day of ['1965-05-30', '2026-10-13', '1900-01-01']) assert.equal((await fetch(`${s.base}/catalog?day=${day}`)).status, 404, day);
  } finally { await close(s.server); }
});

test('catalog: memory LRU, disk cache next to the data (read back by a fresh store), cache off', () => {
  clearHistoryStores();
  const st = getHistoryStore(tr.root);
  st.clear();
  rmSync(join(tr.root, 'cache'), { recursive: true, force: true });
  const a = st.catalogGz(D1);
  assert.equal(a.source, 'built'); assert.ok(a.objects! > 40); assert.ok(a.gz.length < a.rawBytes);
  const dir = join(tr.root, 'cache', 'catalog');
  assert.equal(readdirSync(dir).filter((n) => n.startsWith(D1)).length, 1);
  assert.equal(st.catalogGz(D1).source, 'memory');
  st.clear(); // a new process
  const b = st.catalogGz(D1);
  assert.equal(b.source, 'disk');
  assert.deepEqual(b.gz, a.gz);
  assert.equal(b.rawBytes, a.rawBytes);
  // turned off: nothing is written
  rmSync(join(tr.root, 'cache'), { recursive: true, force: true });
  st.clear(); st.diskCache = false;
  assert.equal(st.catalogGz(D1).source, 'built');
  assert.ok(!existsSync(join(tr.root, 'cache')));
  st.diskCache = true;
});

test('the rolling store: a replay (increasing days) gives the same catalogs as a jump; a jump back is correct', () => {
  const st = getHistoryStore(tr.root);
  st.clear();
  const objects = loadObjects(join(tr.root, 'objects.jsonl.gz'));
  const scratch = (d: string) => catalogAsOfDay(join(tr.root, 'elsets'), objects, d, 30).map((o) => [o.noradId, o.omm.EPOCH]);
  const key = (d: string) => st.dayCatalog(d).map((o) => [o.noradId, o.omm.EPOCH]);
  assert.deepEqual(key(D0), scratch(D0));
  assert.deepEqual(key(D1), scratch(D1));
  assert.deepEqual(key(D0), scratch(D0));
});

test('timeline query parsing and bucket arithmetic', () => {
  const p = parseTimelineQuery({ from: '2009-01-01', to: '2009-12-31', bucket: 'month', kinds: 'object.breakup, elements.jump' });
  assert.deepEqual(p, { ok: true, value: { bucket: 'month', from: '2009-01-01', to: '2009-12-31', kinds: ['object.breakup', 'elements.jump'] } });
  assert.equal((parseTimelineQuery({}) as { ok: true; value: { bucket: string } }).value.bucket, 'month');
  assert.equal(bucketCount('2000-01-01', '2000-12-31', 'day'), 366);
  assert.equal(bucketCount('1959-01-01', '2026-12-31', 'day'), 24_837);
  assert.ok(bucketCount('1800-01-01', '2026-12-31', 'day') > 60_000);
  assert.ok(bucketCount('1959-01-01', '2026-12-31', 'month') < 60_000);
});

test('timeline: SQL group by bucket and kind, kinds filter, window, empty buckets left out', { skip: DB_URL ? false : 'DATABASE_URL not set' }, async () => {
  const db = await createTestDb();
  const s = await serve({ root: tr.root, db: db.pool });
  try {
    const ins = async (day: string, kind: string, n: number) => { for (let i = 0; i < n; i++) await db.pool.query(`INSERT INTO ssa_event (day, kind, subjects) VALUES ($1, $2, '{1}')`, [day, kind]); };
    await ins('2009-01-31', 'object.appeared', 2); await ins('2009-02-01', 'object.appeared', 3); await ins('2009-02-10', 'object.appeared', 4);
    await ins('2009-02-10', 'elements.jump', 1); await ins('2009-02-11', 'object.breakup', 2); await ins('2010-05-05', 'object.disappeared', 7);
    const get = async (q: string) => (await (await fetch(`${s.base}/timeline${q}`)).json()) as HistoryTimelineBucket[];

    const month = await get('?from=2009-01-01&to=2010-12-31&bucket=month');
    assert.deepEqual(month, [
      { t: '2009-01-01T00:00:00.000Z', counts: { 'object.appeared': 2 } },
      { t: '2009-02-01T00:00:00.000Z', counts: { 'elements.jump': 1, 'object.appeared': 7, 'object.breakup': 2 } },
      { t: '2010-05-01T00:00:00.000Z', counts: { 'object.disappeared': 7 } },
    ]);
    const day = await get('?from=2009-02-10&to=2009-02-11&bucket=day');
    assert.deepEqual(day, [
      { t: '2009-02-10T00:00:00.000Z', counts: { 'elements.jump': 1, 'object.appeared': 4 } },
      { t: '2009-02-11T00:00:00.000Z', counts: { 'object.breakup': 2 } },
    ]);
    assert.deepEqual(await get('?from=2009-01-01&to=2010-12-31&bucket=year'), [
      { t: '2009-01-01T00:00:00.000Z', counts: { 'elements.jump': 1, 'object.appeared': 9, 'object.breakup': 2 } },
      { t: '2010-01-01T00:00:00.000Z', counts: { 'object.disappeared': 7 } },
    ]);
    assert.deepEqual(await get('?from=2009-01-01&to=2010-12-31&bucket=year&kinds=object.breakup'), [{ t: '2009-01-01T00:00:00.000Z', counts: { 'object.breakup': 2 } }]);
    assert.deepEqual(await get('?from=2011-01-01&to=2011-12-31'), []);
    // defaults: the events extent of the data
    const dflt = await fetch(`${s.base}/timeline?bucket=year`);
    assert.equal(dflt.status, 200);
    assert.match(dflt.headers.get('cache-control')!, /public, max-age=604800/);
    const tooMany = await fetch(`${s.base}/timeline?from=1800-01-01&to=2026-12-31&bucket=day`);
    assert.equal(tooMany.status, 400);
    const etag = (await fetch(`${s.base}/timeline?from=2009-01-01&to=2010-12-31`)).headers.get('etag')!;
    assert.equal((await fetch(`${s.base}/timeline?from=2009-01-01&to=2010-12-31`, { headers: { 'if-none-match': etag } })).status, 304);
  } finally { await close(s.server); await db.drop(); }
});

test('the files of a root are what the tests above assume (events present)', () => {
  assert.ok(existsSync(join(tr.root, 'events', '2026', `${D1}.jsonl.gz`)));
  assert.ok(readFileSync(join(tr.root, 'objects.jsonl.gz')).length > 0);
});

test('lab layout read in place (explicit paths, no root, era file): catalog = coverage manifest incl. pre-1980 SGP; accuracy from the manifest, else the era file', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } = await import('node:fs');
  const { ERA_TABLE } = await import('../../src/ssa/history/era.js');
  const { historyPathsFrom } = await import('../../src/ssa/config.js');
  const lab = mkdtempSync(join(tmpdir(), 'lab-'));
  try {
    mkdirSync(join(lab, 'merged'), { recursive: true }); mkdirSync(join(lab, 'build'), { recursive: true });
    symlinkSync(join(tr.root, 'elsets'), join(lab, 'merged', 'elsets'));
    symlinkSync(join(tr.root, 'objects.jsonl.gz'), join(lab, 'merged', 'objects.jsonl.gz'));
    symlinkSync(join(tr.root, 'coverage'), join(lab, 'build', 'coverage'));
    symlinkSync(join(tr.root, 'events'), join(lab, 'build', 'events'));
    // an era file with other 1965 accuracy numbers and NO sgp policy for 1965 (the manifests still say which sets the build propagated with SGP)
    const table = ERA_TABLE.map((r) => (r.fromYear === 1965 ? { ...r, sgp: undefined, accuracy: { ...r.accuracy!, medianKm: 55, p95Km: 444 } } : r));
    writeFileSync(join(lab, 'era-merged.json'), JSON.stringify(table));
    const env = {
      SSA_HISTORY_ELSETS_DIR: join(lab, 'merged', 'elsets'), SSA_HISTORY_OBJECTS: join(lab, 'merged', 'objects.jsonl.gz'),
      SSA_HISTORY_COVERAGE_DIR: join(lab, 'build', 'coverage'), SSA_HISTORY_EVENTS_DIR: join(lab, 'build', 'events'), SSA_HISTORY_ERA_FILE: join(lab, 'era-merged.json'),
    };
    const paths = historyPathsFrom(null, env as NodeJS.ProcessEnv)!;
    assert.equal(paths.root, null); assert.equal(paths.coverage, env.SSA_HISTORY_COVERAGE_DIR);
    assert.equal(historyPathsFrom(null, {} as NodeJS.ProcessEnv), null);
    assert.equal(historyPathsFrom('/r', { SSA_HISTORY_EVENTS_DIR: '/e' } as NodeJS.ProcessEnv)!.events, '/e');
    assert.equal(historyPathsFrom('/r', {} as NodeJS.ProcessEnv)!.elsets, '/r/elsets');

    const s = await serve({ root: paths });
    try {
      const range = (await (await fetch(`${s.base}/range`)).json()) as HistoryRange;
      assert.equal(range.firstDay, '1965-06-05'); assert.equal(range.lastDay, D1); assert.equal(range.eventsLastDay, D1);
      for (const day of ['1965-06-05', '1965-06-06']) {
        const body = (await (await fetch(`${s.base}/catalog?day=${day}`)).json()) as HistoryCatalog;
        const m = readManifest(join(tr.root, 'coverage'), day)!;
        assert.deepEqual(body.objects.map((o) => o.noradId), m.norad);
        assert.deepEqual(body.objects.filter((o) => o.propagator === 'sgp').map((o) => o.noradId), m.propagators!.sgp, 'SGP exactly where the build used it');
        assert.equal(m.propagators!.sgp.length, 12);
        assert.deepEqual(body.accuracy, { medianKm: m.accuracy!.medianKm, p95Km: m.accuracy!.p95Km }, 'accuracy of the manifest');
      }
      // a day with element sets but no coverage: accuracy from the era file
      const noCov = (await (await fetch(`${s.base}/catalog?day=1965-06-03`)).json()) as HistoryCatalog;
      assert.deepEqual(noCov.accuracy, { medianKm: 55, p95Km: 444 });
      assert.ok(noCov.objects.length === 12);
      // modern day unaffected
      const d1 = (await (await fetch(`${s.base}/catalog?day=${D1}`)).json()) as HistoryCatalog;
      assert.equal(d1.accuracy, null);
    } finally { await close(s.server); }
  } finally { clearHistoryStores(); rmSync(lab, { recursive: true, force: true }); }
});
