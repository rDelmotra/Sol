// The coverage part of the nightly job against a throwaway Postgres schema and a temp directory: the day's catalog from omm_updates ->
// files + completion record, the catch-up loop picking up days whose files are gone, and a changes failure not blocking coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCoverageDay, coverageJobPart } from '../../src/ssa/coverage/run.js';
import { readManifest, listDays } from '../../src/ssa/coverage/store.js';
import { loadOmmCatalog } from '../../src/ssa/coverage/catalog.js';
import { jobDeps } from '../../src/ssa/job.js';
import { findMissing, runCatchUp } from '../../src/ssa/catchup.js';
import { loadStatuses } from '../../src/ssa/day-status.js';
import { createTestDb, DB_URL } from './db-helper.js';
import { synthCatalog } from './coverage-helpers.js';

const skip = DB_URL ? false : 'DATABASE_URL not set';
const DAYS = ['2026-10-10', '2026-10-11', '2026-10-12'];

async function seed(pool: import('pg').Pool): Promise<void> {
  for (const d of DAYS) {
    for (const o of synthCatalog(24, `${d}T01:00:00.000Z`)) {
      await pool.query('INSERT INTO omm_updates (norad_id, epoch, omm) VALUES ($1, $2, $3)', [o.noradId, `${d}T01:00:00Z`, JSON.stringify(o.omm)]);
    }
  }
  // a later set for one object on the 11th (the 10th's build must not see it: epoch < end of day only)
  await pool.query('INSERT INTO omm_updates (norad_id, epoch, omm) VALUES ($1, $2, $3)', [100, '2026-10-11T05:00:00Z', JSON.stringify({ ...synthCatalog(1, '2026-10-11T05:00:00.000Z')[0]!.omm, INCLINATION: 80 })]);
}

test('catalog of a coverage day: the latest element set before the END of the day, per object, ordered by NORAD id', { skip }, async () => {
  const db = await createTestDb();
  try {
    await seed(db.pool);
    const c10 = await loadOmmCatalog(db.pool, '2026-10-10');
    assert.equal(c10.length, 25);
    assert.deepEqual(c10.map((o) => o.noradId), [...c10.map((o) => o.noradId)].sort((a, b) => a - b));
    assert.equal(c10.find((o) => o.noradId === 100)!.omm.INCLINATION, 53);
    assert.equal((await loadOmmCatalog(db.pool, '2026-10-11')).find((o) => o.noradId === 100)!.omm.INCLINATION, 80);
    assert.deepEqual((await loadOmmCatalog(db.pool, '2026-10-11', [100, 101])).map((o) => o.noradId), [100, 101]);
    assert.equal((await loadOmmCatalog(db.pool, '2026-09-01')).length, 0);
  } finally { await db.drop(); }
});

test('coverage part: files + manifest + completion record; the catch-up loop rebuilds a day whose files are gone; changes failure does not block coverage', { skip, timeout: 300_000 }, async () => {
  const db = await createTestDb();
  const dir = mkdtempSync(join(tmpdir(), 'covdb-'));
  const lockKey: [number, number] = [0x7e57, Math.floor(Math.random() * 1e6)];
  try {
    await seed(db.pool);
    // too small a catalog is skipped, not built
    const small = await runCoverageDay(db.pool, '2026-10-10', { dir, workers: 2 });
    assert.equal(small.status, 'skipped');
    const out = await runCoverageDay(db.pool, '2026-10-10', { dir, workers: 2, minObjects: 10 });
    assert.equal(out.status, 'done');
    const m = readManifest(dir, '2026-10-10')!;
    assert.equal(m.objects, 25);
    assert.deepEqual(m.norad.slice(0, 3), [100, 101, 102]);
    assert.deepEqual(listDays(dir), ['2026-10-10']);
    const st = await loadStatuses(db.pool, '2026-10-10', '2026-10-10');
    assert.deepEqual(st.map((s) => [s.part, s.done]), [['coverage', true]]);

    // catch-up with the real parts (changes will report no catalog: too few objects for minObjects 1000, so it is skipped and recorded)
    const part = coverageJobPart(dir, { minObjects: 10, workers: 2 });
    const deps = jobDeps(db.pool, { coverage: part, screen: { minObjects: 10 } });
    const now = Date.parse('2026-10-14T12:00:00Z');
    const opts = { nowMs: now, lookbackDays: 6, minRows: 10, lockKey, settleMs: 0 };
    const missing = await findMissing(db.pool, deps, opts);
    assert.deepEqual(missing.coverage.days, ['2026-10-11', '2026-10-12']); // 10-10 is done and present
    // the files of 10-10 disappear (volume restored from an older snapshot): it is missing again
    rmSync(join(dir, '2026-10-10'), { recursive: true });
    assert.deepEqual((await findMissing(db.pool, deps, opts)).coverage.days, ['2026-10-10', '2026-10-11', '2026-10-12']);
    const rep = await runCatchUp(db.pool, deps, opts);
    const outcomes = rep.processed.map((p) => `${p.part}:${p.day}:${p.outcome}`);
    // changes cannot run (catalogs below the 1000-object floor): skipped and recorded; coverage runs for every day regardless
    assert.ok(outcomes.includes('changes:2026-10-11:skipped'), outcomes.join(' '));
    for (const d of ['2026-10-10', '2026-10-11', '2026-10-12']) assert.ok(outcomes.includes(`coverage:${d}:done`), outcomes.join(' '));
    assert.deepEqual(listDays(dir), ['2026-10-10', '2026-10-11', '2026-10-12']);
    assert.ok(existsSync(join(dir, '2026-10-12', 'hour.o4.bin')));
    // the order of work: oldest day first, changes before coverage within a day
    const order = rep.processed.map((p) => `${p.day}:${p.part}`);
    assert.deepEqual(order, [...order].sort((a, b) => a.slice(0, 10).localeCompare(b.slice(0, 10)) || (a.endsWith('changes') ? -1 : 1)));
    // the skipped changes days are in back-off, not retried in a loop
    const again = await findMissing(db.pool, deps, opts);
    assert.deepEqual(again.coverage.days, []);
    assert.ok(again.changes.skippedBackoff.length > 0 || again.changes.days.length === 0);
  } finally { rmSync(dir, { recursive: true, force: true }); await db.drop(); }
});
