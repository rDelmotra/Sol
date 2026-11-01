import test from 'node:test';
import assert from 'node:assert/strict';
import { migrations } from '../../src/history/db/migrations/index.js';
import { createTestDb, DB_URL } from './db-helper.js';

test('migration list: 0002_ssa, 0003_omm_updates and 0004_encounter_manoeuvre are appended after 0001_init, no tier column anywhere', () => {
  assert.deepEqual(migrations.map((m) => m.name).slice(0, 4), ['0001_init', '0002_ssa', '0003_omm_updates', '0004_encounter_manoeuvre']);
  for (const m of migrations) assert.ok(!/\btier\b/i.test(m.sql), `${m.name} mentions a tier column`);
});

test('migrations apply on a clean schema; applying them again is a no-op', { skip: DB_URL ? false : 'DATABASE_URL not set' }, async () => {
  const db = await createTestDb(false);
  try {
    const tables = async () => (await db.pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [db.schema])).rows.map((r) => r.table_name);
    const indexes = async () => (await db.pool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY 1`, [db.schema])).rows.map((r) => r.indexname);
    assert.deepEqual(await tables(), []);
    for (const m of migrations) await db.pool.query(m.sql);
    const t1 = await tables(), i1 = await indexes();
    for (const want of ['ssa_run', 'conjunction', 'conjunction_update', 'ssa_event', 'omm_updates', 'omm_daily', 'object_dim']) assert.ok(t1.includes(want), `missing table ${want}`);
    for (const want of ['conjunction_a_tca_idx', 'conjunction_b_tca_idx', 'conjunction_tca_idx', 'conjunction_last_run_idx', 'ssa_event_kind_day_idx', 'ssa_event_subjects_idx', 'ssa_event_t_start_idx', 'omm_updates_epoch_idx']) assert.ok(i1.includes(want), `missing index ${want}`);
    // columns of conjunction: no tier
    const cols = (await db.pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'conjunction'`, [db.schema])).rows.map((r) => r.column_name);
    assert.ok(!cols.includes('tier'));
    assert.deepEqual(['norad_a', 'norad_b', 'tca', 'miss_km', 'vrel_kms', 'ric_km', 'volume', 'pc', 'pc_max', 'hbr_km', 'manoeuvrable', 'label', 'manoeuvre_a', 'manoeuvre_b', 'first_run', 'last_run', 'n_updates'].filter((c) => !cols.includes(c)), []);
    // second application changes nothing
    for (const m of migrations) await db.pool.query(m.sql);
    assert.deepEqual(await tables(), t1);
    assert.deepEqual(await indexes(), i1);
    // the pair order is enforced and omm_updates is unique per (norad, epoch)
    await db.pool.query(`INSERT INTO ssa_run (batch_time) VALUES (now())`);
    await assert.rejects(db.pool.query(`INSERT INTO conjunction (norad_a, norad_b, tca, miss_km, vrel_kms, first_run, last_run) VALUES (2, 1, now(), 1, 1, 1, 1)`));
    await db.pool.query(`INSERT INTO omm_updates (norad_id, epoch, omm) VALUES (1, '2026-01-01T00:00:00Z', '{}')`);
    await assert.rejects(db.pool.query(`INSERT INTO omm_updates (norad_id, epoch, omm) VALUES (1, '2026-01-01T00:00:00Z', '{}')`));
  } finally {
    await db.drop();
  }
});
