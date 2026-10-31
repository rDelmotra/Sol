// /api/ssa read API. Validation + 503 need no database; the DB-backed block runs
// only when DATABASE_URL is set, in a throwaway schema (tables created inline so
// it does not depend on the migration set) that is dropped afterwards.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { createSsaRouter } from '../../src/routes/ssa.js';
import type {
  EncounterDetail,
  ObjectEncounters,
  SsaConjunctionsResponse,
  SsaEventsResponse,
  SsaRunInfo,
} from '@orbitwatch/contracts';

async function serve(router: express.Router): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use('/api/ssa', router);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ssa` };
}

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe('ssa routes: validation and availability (no DB)', () => {
  let server: Server;
  let base: string;
  before(async () => {
    ({ server, base } = await serve(createSsaRouter({ getDb: () => null })));
  });
  after(() => close(server));

  const badQueries = [
    '/conjunctions?norad=abc',
    '/conjunctions?norad=0',
    '/conjunctions?norad=99999999999',
    '/conjunctions?norad=1&norad=2',
    '/conjunctions?from=yesterday',
    '/conjunctions?to=2026-13-45',
    '/conjunctions?from=2026-02-01&to=2026-01-01',
    '/conjunctions?minPc=2',
    '/conjunctions?minPc=x',
    '/conjunctions?maxMissKm=-1',
    '/conjunctions?sort=severity',
    '/conjunctions?limit=0',
    '/conjunctions?limit=1001',
    '/conjunctions?limit=1.5',
    '/conjunctions/abc',
    '/conjunctions/0',
    '/objects/zzz',
    '/events?kind=bad%20kind',
    '/events?since=nope',
    '/events?norad=-4',
    '/events?limit=5000',
  ];
  for (const q of badQueries) {
    it(`400 for ${q}`, async () => {
      const res = await fetch(base + q);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(typeof body.error, 'string');
    });
  }

  it('503 for valid requests when history is unavailable', async () => {
    for (const p of ['/run', '/conjunctions', '/conjunctions/1', '/objects/25544', '/events?kind=jump']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 503, p);
      assert.ok(((await res.json()) as { error: string }).error);
    }
  });

  it('is mounted in createApp and 503s when history is off', async () => {
    const app = createApp({ queryRouter: express.Router() });
    const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    try {
      const port = (s.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/ssa/run`);
      assert.equal(res.status, 503);
    } finally {
      await close(s);
    }
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe('ssa routes: database-backed', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  const schema = `ssa_routes_test_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  const ids: Record<string, number> = {};
  const now = Date.now();
  const h = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

  before(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE object_dim (norad_id INTEGER PRIMARY KEY, object_name TEXT NOT NULL DEFAULT '');
      CREATE TABLE ssa_run (id BIGSERIAL PRIMARY KEY, batch_time TIMESTAMPTZ UNIQUE, element_cutoff TIMESTAMPTZ,
        objects INT, encounters INT, duration_s REAL, code_version TEXT, created_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE conjunction (id BIGSERIAL PRIMARY KEY, norad_a INT, norad_b INT, tca TIMESTAMPTZ, miss_km FLOAT8,
        vrel_kms FLOAT8, ric_km FLOAT8[3], volume TEXT, pc FLOAT8, pc_max FLOAT8, hbr_km FLOAT8,
        manoeuvrable BOOLEAN, label TEXT, first_run BIGINT, last_run BIGINT, n_updates INT);
      CREATE TABLE conjunction_update (conjunction_id BIGINT, run_id BIGINT, tca TIMESTAMPTZ, miss_km FLOAT8,
        pc FLOAT8, pc_max FLOAT8, ric_km FLOAT8[3], PRIMARY KEY (conjunction_id, run_id));
      CREATE TABLE ssa_event (id BIGSERIAL PRIMARY KEY, day DATE, kind TEXT, subjects INT[], t_start TIMESTAMPTZ,
        t_end TIMESTAMPTZ, payload JSONB);
    `);
    await pool.query(
      `INSERT INTO object_dim (norad_id, object_name) VALUES (25544,'ISS (ZARYA)'),(48274,'STARLINK-2305'),
        (44713,'STARLINK-1007'),(44714,'COSMOS 1408 DEB'),(300,'ATLAS 5 R/B')`,
    );
    await pool.query(
      `INSERT INTO ssa_run (batch_time, element_cutoff, objects, encounters, duration_s, code_version) VALUES
        ($1,$2,28000,2,200.5,'abc123'),($3,$4,28100,3,210.25,'abc123')`,
      [h(-26), h(-27), h(-2), h(-3)],
    );
    const runs = (await pool.query(`SELECT id FROM ssa_run ORDER BY id`)).rows.map((r) => Number(r.id));
    const [r1, r2] = runs;
    const ins = async (key: string, a: number, b: number, tca: string, miss: number, pc: number | null,
      man: boolean, firstRun: number, lastRun: number, n: number) => {
      const r = await pool.query(
        `INSERT INTO conjunction (norad_a,norad_b,tca,miss_km,vrel_kms,ric_km,volume,pc,pc_max,hbr_km,manoeuvrable,label,first_run,last_run,n_updates)
         VALUES ($1,$2,$3,$4,10.5,ARRAY[0.1,-0.9,0.4],'1x1x1',$5,$6,0.01,$7,NULL,$8,$9,$10) RETURNING id`,
        [a, b, tca, miss, pc, pc === null ? null : Number((pc * 3).toPrecision(6)), man, firstRun, lastRun, n],
      );
      ids[key] = Number(r.rows[0].id);
    };
    await ins('iss', 25544, 48274, h(2), 1.2, 1e-5, false, r1, r2, 2);
    await ins('deb', 44713, 44714, h(10), 0.3, 1e-3, true, r2, r2, 1);
    await ins('far', 100, 300, h(30), 5, null, false, r2, r2, 1);
    await ins('stale', 25544, 300, h(5), 0.5, 1e-2, false, r1, r1, 1); // not in the latest run
    await pool.query(
      `INSERT INTO conjunction_update (conjunction_id, run_id, tca, miss_km, pc, pc_max, ric_km) VALUES
        ($1,$2,$3,1.5,2e-5,6e-5,ARRAY[0.2,-1.0,0.5]),($1,$4,$5,1.2,1e-5,3e-5,ARRAY[0.1,-0.9,0.4])`,
      [ids.iss, r1, h(2.1), r2, h(2)],
    );
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO ssa_event (day, kind, subjects, t_start, t_end, payload) VALUES
        ($1,'jump',ARRAY[25544],$2,$3,'{"dvMs":0.4}'),
        ($1,'appeared',ARRAY[44714],$4,NULL,'{}'),
        ($1,'formation',ARRAY[25544,48274],$5,$5,'{"n":2}'),
        ($6,'jump',ARRAY[25544],$7,NULL,'{"old":true}')`,
      [today, h(-5), h(-4), h(-8), h(-1), new Date(now - 20 * 86_400_000).toISOString().slice(0, 10), h(-480)],
    );
    ({ server, base } = await serve(createSsaRouter({ getDb: () => pool })));
  });

  after(async () => {
    if (server) await close(server);
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('GET /run returns the latest run with caching headers', async () => {
    const res = await fetch(`${base}/run`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.ok(res.headers.get('etag'));
    const run = (await res.json()) as SsaRunInfo;
    assert.equal(run.objects, 28100);
    assert.equal(run.encounters, 3);
    assert.equal(run.durationS, 210.25);
    assert.equal(run.codeVersion, 'abc123');
    assert.equal(typeof run.batchTime, 'string');
    assert.ok(!Number.isNaN(Date.parse(run.elementCutoff)));
  });

  it('GET /conjunctions lists only the current run, sorted by tca, with names', async () => {
    const res = await fetch(`${base}/conjunctions`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as SsaConjunctionsResponse;
    assert.equal(body.count, 3);
    assert.deepEqual(body.encounters.map((e) => e.id), [ids.iss, ids.deb, ids.far]);
    const iss = body.encounters[0]!;
    assert.deepEqual(iss.a, { noradId: 25544, name: 'ISS (ZARYA)', objectType: null });
    assert.equal(iss.b.name, 'STARLINK-2305');
    assert.deepEqual(iss.ricKm, [0.1, -0.9, 0.4]);
    assert.equal(iss.missKm, 1.2);
    assert.equal(iss.relSpeedKms, 10.5);
    assert.equal(iss.pc, 1e-5);
    assert.equal(iss.pcMax, 3e-5);
    assert.equal(iss.hardBodyRadiusKm, 0.01);
    assert.equal(iss.manoeuvrable, false);
    assert.equal(iss.updates, 2);
    assert.equal(iss.volume, '1x1x1');
    assert.ok(iss.firstSeen && iss.firstSeen < body.run.batchTime);
    assert.equal(body.encounters[1]!.b.objectType, 'DEBRIS');
    assert.equal(body.encounters[1]!.manoeuvrable, true);
    assert.equal(body.encounters[2]!.b.objectType, 'ROCKET BODY');
    assert.equal(body.encounters[2]!.a.name, null);
    assert.equal(body.encounters[2]!.pc, null);
    assert.ok(!JSON.stringify(body).toLowerCase().includes('tier'));
  });

  it('sorts by pc (desc, nulls last) and miss (asc)', async () => {
    const byPc = (await (await fetch(`${base}/conjunctions?sort=pc`)).json()) as SsaConjunctionsResponse;
    assert.deepEqual(byPc.encounters.map((e) => e.id), [ids.deb, ids.iss, ids.far]);
    const byMiss = (await (await fetch(`${base}/conjunctions?sort=miss`)).json()) as SsaConjunctionsResponse;
    assert.deepEqual(byMiss.encounters.map((e) => e.id), [ids.deb, ids.iss, ids.far]);
  });

  it('applies norad, time, pc, miss and limit filters', async () => {
    const get = async (q: string) =>
      ((await (await fetch(`${base}/conjunctions?${q}`)).json()) as SsaConjunctionsResponse).encounters.map((e) => e.id);
    assert.deepEqual(await get('norad=48274'), [ids.iss]);
    assert.deepEqual(await get('norad=300'), [ids.far]); // stale pairing with 25544 excluded
    assert.deepEqual(await get('minPc=0.0001'), [ids.deb]);
    assert.deepEqual(await get('maxMissKm=1.2'), [ids.iss, ids.deb]);
    assert.deepEqual(await get(`from=${encodeURIComponent(h(5))}&to=${encodeURIComponent(h(20))}`), [ids.deb]);
    assert.deepEqual(await get('limit=2'), [ids.iss, ids.deb]);
    assert.deepEqual(await get('norad=999'), []);
  });

  it('GET /conjunctions/:id returns detail with update history; 404 when missing', async () => {
    const res = await fetch(`${base}/conjunctions/${ids.iss}`);
    assert.equal(res.status, 200);
    const d = (await res.json()) as EncounterDetail;
    assert.equal(d.id, ids.iss);
    assert.equal(d.history.length, 2);
    assert.ok(d.history[0]!.runId < d.history[1]!.runId);
    assert.equal(d.history[0]!.missKm, 1.5);
    assert.deepEqual(d.history[1]!.ricKm, [0.1, -0.9, 0.4]);
    assert.equal(d.history[1]!.pcMax, 3e-5);
    const missing = await fetch(`${base}/conjunctions/99999999`);
    assert.equal(missing.status, 404);
    assert.ok(((await missing.json()) as { error: string }).error);
    assert.equal(missing.headers.get('cache-control'), null);
  });

  it('GET /objects/:norad returns current encounters and last-7-day events, newest first', async () => {
    const res = await fetch(`${base}/objects/25544`);
    assert.equal(res.status, 200);
    const o = (await res.json()) as ObjectEncounters;
    assert.equal(o.noradId, 25544);
    assert.equal(o.run?.encounters, 3);
    assert.deepEqual(o.encounters.map((e) => e.id), [ids.iss]);
    assert.deepEqual(o.events.map((e) => e.kind), ['formation', 'jump']); // 20-day-old jump excluded
    assert.deepEqual(o.events[0]!.subjects, [25544, 48274]);
    assert.deepEqual(o.events[1]!.payload, { dvMs: 0.4 });
    assert.match(o.events[0]!.day, /^\d{4}-\d{2}-\d{2}$/);
    const empty = (await (await fetch(`${base}/objects/777`)).json()) as ObjectEncounters;
    assert.deepEqual([empty.encounters, empty.events], [[], []]);
  });

  it('GET /events filters by kind, since, norad and limit', async () => {
    const all = (await (await fetch(`${base}/events`)).json()) as SsaEventsResponse;
    assert.equal(all.count, 4);
    assert.equal(all.events[all.events.length - 1]!.payload && (all.events.at(-1)!.payload as { old?: boolean }).old, true);
    const jumps = (await (await fetch(`${base}/events?kind=jump`)).json()) as SsaEventsResponse;
    assert.equal(jumps.count, 2);
    const recent = (await (await fetch(`${base}/events?kind=jump&since=${encodeURIComponent(h(-24 * 7))}`)).json()) as SsaEventsResponse;
    assert.equal(recent.count, 1);
    const byObj = (await (await fetch(`${base}/events?norad=44714`)).json()) as SsaEventsResponse;
    assert.deepEqual(byObj.events.map((e) => e.kind), ['appeared']);
    const lim = (await (await fetch(`${base}/events?limit=1`)).json()) as SsaEventsResponse;
    assert.equal(lim.count, 1);
  });

  it('honours If-None-Match with 304 and varies the ETag by query', async () => {
    const first = await fetch(`${base}/conjunctions?sort=pc`);
    const etag = first.headers.get('etag')!;
    assert.ok(etag);
    await first.arrayBuffer();
    const again = await fetch(`${base}/conjunctions?sort=pc`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('cache-control'), 'public, max-age=300');
    const other = await fetch(`${base}/conjunctions?sort=miss`, { headers: { 'If-None-Match': etag } });
    assert.equal(other.status, 200);
    assert.notEqual(other.headers.get('etag'), etag);
    await other.arrayBuffer();
    // A new run changes the ETag.
    const rr = await pool.query(
      `INSERT INTO ssa_run (batch_time, element_cutoff, objects, encounters, duration_s, code_version)
       VALUES ($1,$1,1,0,1,'x') RETURNING id`, [h(-1)],
    );
    try {
      const after = await fetch(`${base}/conjunctions?sort=pc`, { headers: { 'If-None-Match': etag } });
      assert.equal(after.status, 200);
      assert.notEqual(after.headers.get('etag'), etag);
      await after.arrayBuffer();
    } finally {
      await pool.query(`DELETE FROM ssa_run WHERE id = $1`, [rr.rows[0].id]);
    }
  });
});

describe('ssa routes: empty database', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  const schema = `ssa_routes_empty_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  before(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE object_dim (norad_id INTEGER PRIMARY KEY, object_name TEXT NOT NULL DEFAULT '');
      CREATE TABLE ssa_run (id BIGSERIAL PRIMARY KEY, batch_time TIMESTAMPTZ, element_cutoff TIMESTAMPTZ, objects INT,
        encounters INT, duration_s REAL, code_version TEXT);
      CREATE TABLE conjunction (id BIGSERIAL PRIMARY KEY, norad_a INT, norad_b INT, tca TIMESTAMPTZ, miss_km FLOAT8,
        vrel_kms FLOAT8, ric_km FLOAT8[3], volume TEXT, pc FLOAT8, pc_max FLOAT8, hbr_km FLOAT8, manoeuvrable BOOLEAN,
        label TEXT, first_run BIGINT, last_run BIGINT, n_updates INT);
      CREATE TABLE conjunction_update (conjunction_id BIGINT, run_id BIGINT, tca TIMESTAMPTZ, miss_km FLOAT8, pc FLOAT8,
        pc_max FLOAT8, ric_km FLOAT8[3]);
      CREATE TABLE ssa_event (id BIGSERIAL PRIMARY KEY, day DATE, kind TEXT, subjects INT[], t_start TIMESTAMPTZ,
        t_end TIMESTAMPTZ, payload JSONB);
    `);
    ({ server, base } = await serve(createSsaRouter({ getDb: () => pool })));
  });
  after(async () => {
    if (server) await close(server);
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it('404 {error} for /run and /conjunctions when no run exists; objects/events still 200', async () => {
    assert.equal((await fetch(`${base}/run`)).status, 404);
    assert.equal((await fetch(`${base}/conjunctions`)).status, 404);
    const o = (await (await fetch(`${base}/objects/25544`)).json()) as ObjectEncounters;
    assert.equal(o.run, null);
    assert.deepEqual(o.encounters, []);
    const e = (await (await fetch(`${base}/events`)).json()) as SsaEventsResponse;
    assert.equal(e.count, 0);
  });
});
