// The file-based backfill against the database path it mirrors, on the same data (a throwaway schema; skipped without DATABASE_URL):
//   catalog as of D (files)        == loadDayCatalog / loadOmmCatalog (omm_updates)
//   build-range events             == deriveDay rows in ssa_event
//   build-range coverage           == runCoverageDay (day.o3 / day.o4 bytes, norad table, unindexed, skipped)
//   import-events                  loads the files into ssa_event + ssa_day_status identically
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadDayCatalog } from '../../src/ssa/events/catalog.js';
import { loadOmmCatalog } from '../../src/ssa/coverage/catalog.js';
import { deriveDay } from '../../src/ssa/events/derive.js';
import { runCoverageDay } from '../../src/ssa/coverage/run.js';
import { readManifest } from '../../src/ssa/coverage/store.js';
import { catalogAsOfDay, regimeOf } from '../../src/ssa/history/catalog-files.js';
import { loadObjects } from '../../src/ssa/history/elset-files.js';
import { summarizeOrbit } from '../../src/utils/orbit-summary.js';
import { importEvents } from '../../scripts/history/import-events.js';
import { createTestDb, DB_URL } from './db-helper.js';
import { D0, D1, synthWorld, writeWorld } from './history-helpers.js';
import { runBuildRange } from './history-run.js';

const skip = DB_URL ? false : 'DATABASE_URL not set';

test('file backfill == database path: catalogs, events, coverage, importer', { skip, timeout: 600_000 }, async () => {
  const db = await createTestDb();
  const dir = mkdtempSync(join(tmpdir(), 'histpar-'));
  try {
    const world = synthWorld();
    // the DB path knows no decay dates: parity runs on objects without them (decay exclusion is covered in history-catalog.test.ts)
    const w = { sets: world.sets, objects: world.objects.map((o) => ({ ...o, decayDate: null })) };
    const files = writeWorld(dir, w);
    const objects = loadObjects(files.objects);
    for (const s of w.sets) await db.pool.query('INSERT INTO omm_updates (norad_id, epoch, omm) VALUES ($1, $2, $3)', [s.noradId, new Date(s.epochMs).toISOString(), JSON.stringify(s.omm)]);
    for (const o of w.objects) {
      await db.pool.query('INSERT INTO object_dim (norad_id, object_name, launch_date, first_seen, last_seen) VALUES ($1, $2, $3, $4, $4)', [o.noradId, o.name, o.launchDate, o.firstEpoch!.slice(0, 10)]);
      const last = w.sets.filter((s) => s.noradId === o.noradId).at(-1)!;
      const sum = summarizeOrbit(Number(last.omm.MEAN_MOTION), Number(last.omm.ECCENTRICITY))!;
      await db.pool.query(
        `INSERT INTO omm_daily (norad_id, utc_day, epoch, mean_motion, eccentricity, inclination, ra_of_asc_node, arg_of_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot, regime)
         VALUES ($1, $2, $3, 1, 0, 0, 0, 0, 0, 0, 0, 0, $4)`, [o.noradId, last.epochMs && new Date(last.epochMs).toISOString().slice(0, 10), new Date(last.epochMs).toISOString(), regimeOf(sum.period, Number(last.omm.ECCENTRICITY))]);
    }

    // 1. catalogs
    for (const d of [D0, D1]) {
      const dbCat = await loadDayCatalog(db.pool, d);
      const fileCat = catalogAsOfDay(files.elsets, objects, d, 30);
      assert.deepEqual(JSON.parse(JSON.stringify(fileCat)), JSON.parse(JSON.stringify(dbCat)), `catalog ${d}`);
      assert.deepEqual((await loadOmmCatalog(db.pool, d)).map((o) => o.noradId), fileCat.map((o) => o.noradId));
    }

    // 2. build-range on the two days
    const out = join(dir, 'out');
    const r = runBuildRange(['--elsets', files.elsets, '--objects', files.objects, '--out', out, '--from', D0, '--to', D1, '--workers', '2']);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    // 3. events == deriveDay
    for (const d of [D0, D1]) {
      const res = await deriveDay(db.pool, d, { minObjects: 1 });
      assert.equal(res.status, 'written');
      const dbRows = (await db.pool.query('SELECT kind, subjects, extract(epoch FROM t_start) * 1000 AS ts, extract(epoch FROM t_end) * 1000 AS te, payload FROM ssa_event WHERE day = $1::date', [d])).rows as Array<{ kind: string; subjects: number[]; ts: string; te: string; payload: unknown }>;
      const fileRows = gunzipSync(readFileSync(join(out, 'events', d.slice(0, 4), `${d}.jsonl.gz`))).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { day: string; kind: string; subjects: number[]; t_start: string; t_end: string; payload: unknown });
      const key = (k: string, s: number[]) => `${k}:${s.join(',')}`;
      assert.deepEqual(fileRows.map((x) => key(x.kind, x.subjects)).sort(), dbRows.map((x) => key(x.kind, x.subjects)).sort(), `event keys ${d}`);
      for (const f of fileRows) {
        const g = dbRows.find((x) => key(x.kind, x.subjects) === key(f.kind, f.subjects))!;
        assert.ok(Math.abs(Date.parse(f.t_start) - Number(g.ts)) <= 1 && Math.abs(Date.parse(f.t_end) - Number(g.te)) <= 1, `times ${key(f.kind, f.subjects)}`);
        assert.deepEqual(f.payload, g.payload, `payload ${key(f.kind, f.subjects)}`);
        assert.equal(f.day, d);
      }
      if (d === D1) assert.deepEqual([...new Set(fileRows.map((x) => x.kind))].sort(), ['close.formation', 'elements.jump', 'object.appeared', 'object.disappeared']);
    }

    // 4. coverage == runCoverageDay
    const dbDir = join(dir, 'dbcov');
    for (const d of [D0, D1]) {
      const o = await runCoverageDay(db.pool, d, { dir: dbDir, workers: 2, minObjects: 1 });
      assert.equal(o.status, 'done');
      const a = readManifest(dbDir, d)!, b = readManifest(join(out, 'coverage'), d)!;
      assert.deepEqual(b.norad, a.norad);
      assert.deepEqual(b.unindexed, a.unindexed);
      assert.deepEqual(b.skipped, a.skipped);
      assert.deepEqual(Object.keys(b.layers).sort(), ['day.o3', 'day.o4'], 'no hourly layer');
      assert.ok(Object.keys(a.layers).includes('hour.o4'));
      for (const f of ['day.o3.bin', 'day.o4.bin']) assert.ok(readFileSync(join(dbDir, d, f)).equals(readFileSync(join(out, 'coverage', d, f))), `${d} ${f} bytes`);
    }

    // 5. importer: a second schema state: clear the rows deriveDay wrote and load the files instead
    await db.pool.query('DELETE FROM ssa_event');
    await db.pool.query('DELETE FROM ssa_day_status');
    const imp = await importEvents(db.pool, out, { coverageDir: join(out, 'coverage') });
    assert.equal(imp.days, 2);
    assert.equal(imp.markedChanges, 2);
    assert.equal(imp.markedCoverage, 2);
    const n = (await db.pool.query('SELECT count(*)::int AS n FROM ssa_event WHERE day = $1::date', [D1])).rows[0].n as number;
    const nFile = gunzipSync(readFileSync(join(out, 'events', D1.slice(0, 4), `${D1}.jsonl.gz`))).toString().split('\n').filter(Boolean).length;
    assert.equal(n, nFile);
    const st = (await db.pool.query('SELECT day::text AS day, part, done_at IS NOT NULL AS done FROM ssa_day_status ORDER BY day, part')).rows;
    assert.deepEqual(st.map((x) => [x.day, x.part, x.done]), [[D0, 'changes', true], [D0, 'coverage', true], [D1, 'changes', true], [D1, 'coverage', true]]);
    // idempotent: a second import leaves the same rows
    await importEvents(db.pool, out, {});
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ssa_event WHERE day = $1::date', [D1])).rows[0].n, nFile);
  } finally {
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  }
});
