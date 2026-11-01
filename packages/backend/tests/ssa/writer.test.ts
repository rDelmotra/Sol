import test from 'node:test';
import assert from 'node:assert/strict';
import { writeRun } from '../../src/ssa/writer.js';
import { insertOmmUpdates } from '../../src/history/ingest/omm-updates.js';
import { loadCatalogFromDb } from '../../src/ssa/catalog.js';
import type { Encounter } from '../../src/ssa/types.js';
import { createTestDb, DB_URL } from './db-helper.js';

const T0 = Date.parse('2026-10-12T12:00:00Z');
const enc = (a: number, b: number, tcaMs: number, over: Partial<Encounter> = {}): Encounter => ({
  noradA: a, noradB: b, nameA: `OBJ ${a}`, nameB: `OBJ ${b}`, tcaMs, missKm: 1.5, vrelKms: 10.5, ricKm: [0.1, 1.2, -0.3], volume: 'LEO1',
  pc: 1e-6, pcMax: 5e-6, hbrKm: 0.004, manoeuvrable: false, label: 'crossing', epochA: T0 - 1e6, epochB: T0 - 2e6, ageDaysA: 1, ageDaysB: 2, sigmaMajKm: 1, sigmaMinKm: 0.3, ...over,
});
const skip = DB_URL ? false : 'DATABASE_URL not set';

test('writer: one run, idempotent per batch_time', { skip }, async () => {
  const db = await createTestDb();
  try {
    const es = [enc(1, 2, T0 + 3_600_000), enc(1, 3, T0 + 7_200_000), enc(5, 9, T0 + 9_000_000, { ricKm: [1, 2, 3], pc: NaN })];
    const info = { batchTimeMs: T0, elementCutoffMs: T0 - 1000, objects: 10, durationS: 12.5 };
    const w1 = await writeRun(db.pool, info, es);
    assert.deepEqual([w1.written, w1.inserted, w1.updated], [true, 3, 0]);
    const count = async (t: string) => Number((await db.pool.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
    assert.equal(await count('ssa_run'), 1);
    assert.equal(await count('conjunction'), 3);
    assert.equal(await count('conjunction_update'), 3);
    const run = (await db.pool.query(`SELECT objects, encounters, duration_s, code_version, extract(epoch from batch_time) * 1000 AS bt FROM ssa_run`)).rows[0];
    assert.deepEqual([run.objects, run.encounters, run.duration_s, Number(run.bt)], [10, 3, 12.5, T0]);
    assert.ok(run.code_version);
    const row = (await db.pool.query(`SELECT * FROM conjunction WHERE norad_a = 5`)).rows[0];
    assert.deepEqual(row.ric_km, [1, 2, 3]);
    assert.equal(row.n_updates, 1);
    assert.equal(row.first_run, row.last_run);
    assert.ok(Number.isNaN(row.pc));
    // the same batch time again: nothing changes
    const w2 = await writeRun(db.pool, info, es);
    assert.equal(w2.written, false);
    assert.equal(w2.runId, w1.runId);
    assert.deepEqual([await count('ssa_run'), await count('conjunction'), await count('conjunction_update')], [1, 3, 3]);
  } finally {
    await db.drop();
  }
});

test('writer: a later run updates the matching conjunction (same pair, TCA within 60 s) and opens the others', { skip }, async () => {
  const db = await createTestDb();
  try {
    const tca1 = T0 + 30 * 3_600_000;
    await writeRun(db.pool, { batchTimeMs: T0, elementCutoffMs: null, objects: 3, durationS: 1 }, [enc(1, 2, tca1), enc(1, 2, tca1 + 5_000_000), enc(3, 4, tca1)]);
    const T1 = T0 + 24 * 3_600_000;
    // (1,2) re-predicted 40 s later -> matches the first; (1,2) 90 s off the second -> new; (3,4) 61 s off -> new; (7,8) -> new
    const w = await writeRun(db.pool, { batchTimeMs: T1, elementCutoffMs: null, objects: 3, durationS: 1 }, [
      enc(1, 2, tca1 + 40_000, { missKm: 0.8, pc: 3e-5 }),
      enc(1, 2, tca1 + 5_000_000 + 90_000),
      enc(3, 4, tca1 + 61_000),
      enc(7, 8, tca1),
    ]);
    assert.deepEqual([w.written, w.inserted, w.updated], [true, 3, 1]);
    const q = async (s: string) => (await db.pool.query(s)).rows;
    assert.equal((await q('SELECT count(*)::int AS n FROM conjunction'))[0].n, 6);
    const m = (await q(`SELECT c.*, extract(epoch from c.tca) * 1000 AS ms FROM conjunction c WHERE norad_a = 1 ORDER BY c.id`))[0];
    assert.equal(m.n_updates, 2);
    assert.notEqual(m.first_run, m.last_run);
    assert.equal(m.miss_km, 0.8);
    assert.equal(m.pc, 3e-5);
    assert.equal(Math.round(Number(m.ms)), tca1 + 40_000);
    const hist = await q(`SELECT run_id, miss_km FROM conjunction_update WHERE conjunction_id = ${m.id} ORDER BY run_id`);
    assert.equal(hist.length, 2);
    assert.deepEqual(hist.map((h) => h.miss_km), [1.5, 0.8]);
    assert.equal((await q('SELECT count(*)::int AS n FROM conjunction_update'))[0].n, 7);
    assert.equal((await q('SELECT count(*)::int AS n FROM conjunction WHERE n_updates = 1 AND last_run = first_run'))[0].n, 5);
  } finally {
    await db.drop();
  }
});

test('omm_updates: insert is idempotent and the catalog loader takes the latest set at or before the batch time', { skip }, async () => {
  const db = await createTestDb();
  try {
    const o = (id: number, epoch: string, mm = 15) => ({ noradId: id, name: `OBJ ${id}`, epoch, omm: { OBJECT_NAME: `OBJ ${id}`, EPOCH: epoch, MEAN_MOTION: mm }, objectType: 'unknown' }) as never;
    const sets = [o(1, '2026-10-12T06:00:00.000Z'), o(1, '2026-10-12T11:00:00.000Z', 15.1), o(1, '2026-10-12T13:00:00.000Z', 15.2), o(2, '2026-10-12T14:00:00.000Z'), o(3, '2026-08-01T00:00:00.000Z')];
    assert.equal(await insertOmmUpdates(db.pool, sets), 5);
    assert.equal(await insertOmmUpdates(db.pool, sets), 0);
    const cat = await loadCatalogFromDb(db.pool, Date.parse('2026-10-12T12:00:00Z'));
    assert.deepEqual(cat.map((c) => [c.noradId, c.omm.MEAN_MOTION]), [[1, 15.1]]); // 2 is in the future, 3 is older than the 60-day cap
    const cat2 = await loadCatalogFromDb(db.pool, Date.parse('2026-10-12T15:00:00Z'));
    assert.deepEqual(cat2.map((c) => [c.noradId, c.omm.MEAN_MOTION]), [[1, 15.2], [2, 15]]);
  } finally {
    await db.drop();
  }
});

test('writer: manoeuvre_a / manoeuvre_b are stored on new rows and refreshed on matched ones', { skip }, async () => {
  const db = await createTestDb();
  try {
    const tca = T0 + 20 * 3_600_000, m1 = T0 - 2 * 86_400_000;
    await writeRun(db.pool, { batchTimeMs: T0, elementCutoffMs: null, objects: 2, durationS: 1 }, [
      enc(1, 2, tca, { manoeuvreAMs: m1, manoeuvreBMs: null }),
      enc(3, 4, tca), // not looked up: stored as NULL
      enc(5, 6, tca, { manoeuvreAMs: null, manoeuvreBMs: m1 + 1000 }),
    ]);
    const q = async () => (await db.pool.query(`SELECT norad_a, extract(epoch FROM manoeuvre_a) * 1000 AS ma, extract(epoch FROM manoeuvre_b) * 1000 AS mb FROM conjunction ORDER BY norad_a`)).rows.map((r) => [r.norad_a, r.ma === null ? null : Number(r.ma), r.mb === null ? null : Number(r.mb)]);
    assert.deepEqual(await q(), [[1, m1, null], [3, null, null], [5, null, m1 + 1000]]);
    // the next run re-predicts (1,2) after object 2 also changed orbit, and (5,6) with no recent change on record any more
    const T1 = T0 + 24 * 3_600_000, m2 = T0 + 3_600_000;
    const w = await writeRun(db.pool, { batchTimeMs: T1, elementCutoffMs: null, objects: 2, durationS: 1 }, [
      enc(1, 2, tca + 1000, { manoeuvreAMs: m1, manoeuvreBMs: m2 }),
      enc(5, 6, tca + 1000, { manoeuvreAMs: null, manoeuvreBMs: null }),
    ]);
    assert.equal(w.updated, 2);
    assert.deepEqual(await q(), [[1, m1, m2], [3, null, null], [5, null, null]]);
  } finally {
    await db.drop();
  }
});
