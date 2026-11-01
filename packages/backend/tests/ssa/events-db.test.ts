// Change detection against a throwaway Postgres schema (skipped when DATABASE_URL is not set): the event writer, the day catalog
// loader, the recent-jump lookup, deriveDay end to end, migration 0004 on a populated schema, and the nightly job's order of work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeDayEvents } from '../../src/ssa/events/writer.js';
import { loadDayCatalog, loadRecentJumps, previousUtcDay } from '../../src/ssa/events/catalog.js';
import { deriveDay } from '../../src/ssa/events/derive.js';
import { runChanges, runNightly } from '../../src/ssa/nightly.js';
import { migrations } from '../../src/history/db/migrations/index.js';
import type { EventRow } from '../../src/ssa/events/types.js';
import { createTestDb, DB_URL } from './db-helper.js';

const skip = DB_URL ? false : 'DATABASE_URL not set';
const D = 86_400_000, H = 3_600_000;
const day0 = (day: string) => Date.parse(day + 'T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const row = (kind: EventRow['kind'], subjects: number[], t: number, payload: Record<string, unknown> = {}): EventRow => ({ kind, subjects, tStart: t, tEnd: t + 1000, payload });

const omm = (id: number, epochMs: number, over: Record<string, unknown> = {}) => ({
  OBJECT_NAME: `OBJ-${id}`, OBJECT_ID: `2020-0${id}A`, EPOCH: iso(epochMs), MEAN_MOTION: 15.1, ECCENTRICITY: 0.0001, INCLINATION: 53, RA_OF_ASC_NODE: 10,
  ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0, BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: id, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1000, ...over,
});
type Pool = Awaited<ReturnType<typeof createTestDb>>['pool'];
async function put(pool: Pool, id: number, epochMs: number, over: Record<string, unknown> = {}) {
  await pool.query('INSERT INTO omm_updates (norad_id, epoch, omm) VALUES ($1, $2, $3)', [id, iso(epochMs), JSON.stringify(omm(id, epochMs, over))]);
}
const count = async (pool: Pool, where = 'true') => Number((await pool.query(`SELECT count(*) FROM ssa_event WHERE ${where}`)).rows[0].count);

test('event writer: one transaction per day, idempotent per (day, kind set), other kinds and days untouched', { skip }, async () => {
  const db = await createTestDb();
  try {
    const t = day0('2026-10-12');
    const rows = [row('object.appeared', [5], t, { cls: 'new_launch' }), row('elements.jump', [7], t, { dpos: 20.5 }), row('close.formation', [8, 9], t, { frac: 0.9, minKm: 3 })];
    const kinds = ['object.appeared', 'object.disappeared', 'elements.jump', 'close.formation'] as const;
    assert.deepEqual(await writeDayEvents(db.pool, '2026-10-12', kinds, rows), { deleted: 0, inserted: 3, perKind: { 'object.appeared': 1, 'elements.jump': 1, 'close.formation': 1 } });
    await writeDayEvents(db.pool, '2026-10-13', kinds, [row('elements.jump', [7], t + D)]);
    // the same day again: replaced, not doubled
    const again = await writeDayEvents(db.pool, '2026-10-12', kinds, rows);
    assert.deepEqual([again.deleted, again.inserted], [3, 3]);
    assert.equal(await count(db.pool, `day = '2026-10-12'`), 3);
    assert.equal(await count(db.pool, `day = '2026-10-13'`), 1);
    // a day written without the formation kind keeps its earlier formation rows
    await writeDayEvents(db.pool, '2026-10-12', ['object.appeared', 'object.disappeared', 'elements.jump'], [row('elements.jump', [7], t, { dpos: 99 })]);
    assert.equal(await count(db.pool, `day = '2026-10-12' AND kind = 'close.formation'`), 1);
    assert.equal(await count(db.pool, `day = '2026-10-12' AND kind = 'object.appeared'`), 0);
    const r = (await db.pool.query(`SELECT subjects, payload, extract(epoch FROM t_start) * 1000 AS ts, to_char(day, 'YYYY-MM-DD') AS d FROM ssa_event WHERE kind = 'close.formation'`)).rows[0];
    assert.deepEqual([r.subjects, r.payload, Number(r.ts), r.d], [[8, 9], { frac: 0.9, minKm: 3 }, t, '2026-10-12']);
    // a row outside the kind set aborts before anything is deleted
    await assert.rejects(writeDayEvents(db.pool, '2026-10-12', ['elements.jump'], [row('object.appeared', [1], t)]));
    assert.equal(await count(db.pool, `day = '2026-10-12'`), 2);
    // an empty day clears its kinds
    await writeDayEvents(db.pool, '2026-10-13', kinds, []);
    assert.equal(await count(db.pool, `day = '2026-10-13'`), 0);
  } finally {
    await db.drop();
  }
});

test('day catalog: latest set before the day end within 30 days; recent jumps are causal and 7 days deep', { skip }, async () => {
  const db = await createTestDb();
  try {
    const d = day0('2026-10-12');
    await put(db.pool, 1, d - 3 * D);
    await put(db.pool, 1, d + 5 * H, { MEAN_MOTION: 15.2 }); // on the day: the one used
    await put(db.pool, 1, d + D + H, { MEAN_MOTION: 15.3 }); // after the day's end: not yet
    await put(db.pool, 2, d + D - 30 * D - H); // just outside the 30-day window
    await put(db.pool, 3, d + D - 30 * D + H); // just inside
    const cat = await loadDayCatalog(db.pool, '2026-10-12');
    assert.deepEqual(cat.map((c) => [c.noradId, c.omm.MEAN_MOTION]), [[1, 15.2], [3, 15.1]]);
    assert.ok(cat[0]!.perigee! > 400 && cat[0]!.perigee! < 700 && cat[0]!.apogee! >= cat[0]!.perigee!);
    assert.equal(cat[0]!.regime, 'OTHER'); // no omm_daily row: the default
    assert.equal(previousUtcDay(Date.parse('2026-10-13T02:00:00Z')), '2026-10-12');

    const b = Date.parse('2026-10-13T12:00:00Z');
    const jump = (id: number, endMs: number) => row('elements.jump', [id], endMs - D).tEnd === 0 ? null : ({ kind: 'elements.jump', subjects: [id], tStart: endMs - D, tEnd: endMs, payload: {} }) as EventRow;
    await writeDayEvents(db.pool, '2026-10-12', ['elements.jump'], [
      jump(1, b - 2 * D)!, jump(1, b - 3 * D)!, // two for object 1: the latest wins
      jump(2, b - 8 * D)!, // too old
      jump(3, b + H)!, // after the batch: not known yet
      jump(4, b - H)!,
    ]);
    const m = await loadRecentJumps(db.pool, b);
    assert.deepEqual([...m.entries()].sort((x, y) => x[0] - y[0]), [[1, b - 2 * D], [4, b - H]]);
  } finally {
    await db.drop();
  }
});

test('deriveDay: appeared / disappeared / jump from omm_updates, written once per day; too-small catalogs are skipped', { skip }, async () => {
  const db = await createTestDb();
  try {
    const d = day0('2026-10-12');
    // before the day: 1 (will jump), 2 (will vanish), 3 (unchanged)
    for (const id of [1, 2, 3]) await put(db.pool, id, d - 12 * H);
    // on the day: 1 with a lower orbit, 4 is new (launched 3 days ago)
    await put(db.pool, 1, d + 2 * H, { MEAN_MOTION: 15.12 });
    await put(db.pool, 4, d + 3 * H);
    await db.pool.query(`INSERT INTO object_dim (norad_id, object_name, launch_date, first_seen, last_seen) VALUES (4, 'NEWSAT', $1, $2, $2)`, ['2026-10-09', '2026-10-12']);
    // object 2 has no set inside the window of the day: its set is 31 days old
    await db.pool.query(`UPDATE omm_updates SET epoch = $1, omm = jsonb_set(omm, '{EPOCH}', to_jsonb($2::text)) WHERE norad_id = 2`, [iso(d + D - 31 * D), iso(d + D - 31 * D)]);
    await put(db.pool, 2, d + D - 31 * D - 2 * D); // (an older one so object 2 is also absent from the day before)
    const small = await deriveDay(db.pool, '2026-10-12');
    assert.equal(small.status, 'no-catalog');
    assert.equal(await count(db.pool), 0);
    const res = await deriveDay(db.pool, '2026-10-12', { minObjects: 2 });
    assert.equal(res.status, 'written');
    assert.equal(res.perKind['elements.jump'], 1);
    assert.equal(res.perKind['object.appeared'], 1);
    const ev = (await db.pool.query(`SELECT kind, subjects, payload FROM ssa_event ORDER BY kind, id`)).rows;
    assert.ok(ev.some((e) => e.kind === 'elements.jump' && e.subjects[0] === 1 && e.payload.dir === 'lower'));
    const app = ev.find((e) => e.kind === 'object.appeared')!;
    assert.deepEqual([app.subjects, app.payload.cls, app.payload.name], [[4], 'new_launch', 'NEWSAT']);
    const n = await count(db.pool);
    await deriveDay(db.pool, '2026-10-12', { minObjects: 2 });
    assert.equal(await count(db.pool), n, 'a second run replaces the day, it does not add to it');
    assert.equal((await runChanges('2026-10-12', { pool: db.pool, dryRun: true, minObjects: 2 })).status, 'dry-run');
    assert.equal(await count(db.pool), n);
  } finally {
    await db.drop();
  }
});

test('migration 0004 adds the manoeuvre columns to a populated schema without touching rows', { skip }, async () => {
  const db = await createTestDb(false);
  try {
    for (const m of migrations.slice(0, 3)) await db.pool.query(m.sql);
    await db.pool.query(`INSERT INTO ssa_run (batch_time) VALUES (now())`);
    await db.pool.query(`INSERT INTO conjunction (norad_a, norad_b, tca, miss_km, vrel_kms, first_run, last_run) VALUES (1, 2, now(), 1, 1, 1, 1)`);
    const m4 = migrations.find((m) => m.name === '0004_encounter_manoeuvre')!;
    await db.pool.query(m4.sql);
    await db.pool.query(m4.sql); // idempotent
    const r = (await db.pool.query(`SELECT manoeuvre_a, manoeuvre_b FROM conjunction`)).rows;
    assert.deepEqual(r, [{ manoeuvre_a: null, manoeuvre_b: null }]);
    const t = (await db.pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'conjunction' AND column_name LIKE 'manoeuvre_%' ORDER BY 1`, [db.schema])).rows;
    assert.deepEqual(t.map((x) => [x.column_name, x.data_type, x.is_nullable]), [['manoeuvre_a', 'timestamp with time zone', 'YES'], ['manoeuvre_b', 'timestamp with time zone', 'YES']]);
  } finally {
    await db.drop();
  }
});

test('nightly: changes are derived first and flag the encounter; a failing change detection does not stop the screen', { skip, timeout: 240_000 }, async () => {
  const db = await createTestDb();
  try {
    // the screen-synthetic pair (crossing planes) plus a far object; sets of 2026-10-10 and 10-11 (object 10 changes orbit on the 11th)
    const e3 = Date.parse('2026-10-12T11:00:00Z');
    const spec: Array<[number, Record<string, unknown>]> = [[10, { INCLINATION: 53 }], [11, { INCLINATION: 98, MEAN_ANOMALY: 0.46 }], [12, { INCLINATION: 53, MEAN_ANOMALY: 180, MEAN_MOTION: 2.0057 }]];
    for (const [id, o] of spec) {
      await put(db.pool, id, day0('2026-10-10') + 12 * H, o);
      await put(db.pool, id, e3, o);
    }
    await put(db.pool, 10, day0('2026-10-11') + 12 * H, { INCLINATION: 53, MEAN_MOTION: 15.12 });
    const batch = Date.parse('2026-10-12T11:30:00Z'); // the pair meets within 3 h of 12:00, so every window below holds the encounter
    const r1 = await runNightly({ pool: db.pool, batchTimeMs: batch, hours: 4, workers: 2, minObjects: 3 });
    assert.equal(r1.status, 'written');
    assert.ok(r1.changes && r1.changes.status === 'written' && r1.changes.day === '2026-10-11', JSON.stringify(r1.changes));
    assert.equal(r1.manoeuvredObjects, 1);
    assert.ok(r1.encounters >= 1);
    const c = (await db.pool.query(`SELECT norad_a, norad_b, extract(epoch FROM manoeuvre_a) * 1000 AS ma, manoeuvre_b FROM conjunction ORDER BY id`)).rows;
    assert.ok(c.length >= 1);
    for (const x of c) {
      assert.deepEqual([x.norad_a, x.norad_b], [10, 11]);
      assert.ok(Math.abs(Number(x.ma) - (day0('2026-10-11') + 12 * H)) < 1, `manoeuvre_a ${x.ma}`);
      assert.equal(x.manoeuvre_b, null);
    }
    // change detection fails (bad day): logged, the screen still runs and still gets the flags already on record
    const r2 = await runNightly({ pool: db.pool, batchTimeMs: batch + 15 * 60_000, hours: 4, workers: 2, minObjects: 3, changeDay: 'not-a-day' });
    assert.equal(r2.status, 'written');
    assert.equal(r2.changes?.status, 'failed');
    assert.ok(r2.encounters >= 1);
    // --skip-changes: no derivation, flags still read
    const r3 = await runNightly({ pool: db.pool, batchTimeMs: batch + 30 * 60_000, hours: 4, workers: 2, minObjects: 3, skipChanges: true });
    assert.equal(r3.changes?.status, 'skipped');
    assert.equal(r3.manoeuvredObjects, 1);
    // later runs matched the first batch's encounter and kept the flag
    const m = (await db.pool.query(`SELECT count(*)::int AS n, count(manoeuvre_a)::int AS flagged FROM conjunction WHERE n_updates > 1`)).rows[0];
    assert.ok(m.n >= 1 && m.flagged === m.n, JSON.stringify(m));
  } finally {
    await db.drop();
  }
});
