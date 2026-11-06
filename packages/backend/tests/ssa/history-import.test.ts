// scripts/history/import-events.ts: loads a history build's events into ssa_event + ssa_day_status, idempotently (a second import changes
// nothing), per-kind counts equal the files', coverage marks, the object.breakup file (replaced as a whole, range respected), dry run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { importEvents, eventDays } from '../../scripts/history/import-events.js';
import { createTestDb, DB_URL } from './db-helper.js';
import { buildTestRoot } from './history-root.js';

const tr = buildTestRoot();
test.after(() => tr.cleanup());
const skip = DB_URL ? false : 'DATABASE_URL not set';

const fileCounts = (root: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const d of eventDays(root)) {
    for (const l of gunzipSync(readFileSync(join(root, 'events', d.slice(0, 4), `${d}.jsonl.gz`))).toString().split('\n').filter(Boolean)) {
      const k = (JSON.parse(l) as { kind: string }).kind;
      out[k] = (out[k] ?? 0) + 1;
    }
  }
  return out;
};

test('import: rows per kind equal the files\', day status marked, a second import is a no-op, coverage marks follow --coverage', { skip, timeout: 120_000 }, async () => {
  const db = await createTestDb();
  try {
    const want = fileCounts(tr.root);
    const total = Object.values(want).reduce((a, b) => a + b, 0);
    assert.ok(total > 0 && eventDays(tr.root).length === 4);
    const r1 = await importEvents(db.pool, tr.root, { coverageDir: join(tr.root, 'coverage') });
    assert.equal(r1.days, 4); assert.equal(r1.rows, total); assert.equal(r1.markedChanges, 4); assert.equal(r1.markedCoverage, 4); assert.equal(r1.breakups, 0);
    const kinds = async () => Object.fromEntries((await db.pool.query(`SELECT kind, count(*)::int AS n FROM ssa_event GROUP BY kind`)).rows.map((x: { kind: string; n: number }) => [x.kind, x.n]));
    assert.deepEqual(await kinds(), want);
    const st1 = (await db.pool.query(`SELECT part, count(*)::int AS n FROM ssa_day_status WHERE done_at IS NOT NULL GROUP BY part ORDER BY part`)).rows;
    assert.deepEqual(st1, [{ part: 'changes', n: 4 }, { part: 'coverage', n: 4 }]);
    const ids1 = (await db.pool.query(`SELECT array_agg(id ORDER BY id) AS ids FROM ssa_event`)).rows[0].ids as number[];

    // again: same rows (new ids: the day's rows are replaced), same counts, same status
    const r2 = await importEvents(db.pool, tr.root, { coverageDir: join(tr.root, 'coverage') });
    assert.deepEqual(r2, r1);
    assert.deepEqual(await kinds(), want);
    assert.deepEqual((await db.pool.query(`SELECT part, count(*)::int AS n FROM ssa_day_status WHERE done_at IS NOT NULL GROUP BY part ORDER BY part`)).rows, st1);
    const ids2 = (await db.pool.query(`SELECT array_agg(id ORDER BY id) AS ids FROM ssa_event`)).rows[0].ids as number[];
    assert.equal(ids2.length, ids1.length);

    // a range import touches only its days
    const r3 = await importEvents(db.pool, tr.root, { from: '2026-10-12', to: '2026-10-12' });
    assert.equal(r3.days, 1);
    assert.deepEqual(await kinds(), want);

    // dry run writes nothing
    const db2 = await createTestDb();
    try {
      const d = await importEvents(db2.pool, tr.root, { dryRun: true });
      assert.equal(d.days, 4);
      assert.equal((await db2.pool.query('SELECT count(*)::int AS n FROM ssa_event')).rows[0].n, 0);
    } finally { await db2.drop(); }
  } finally { await db.drop(); }
});

test('import: events/breakups.jsonl.gz replaces the object.breakup rows (whole file, or only the --from/--to range); never duplicates', { skip, timeout: 120_000 }, async () => {
  const db = await createTestDb();
  const dir = mkdtempSync(join(tmpdir(), 'imp-'));
  try {
    cpSync(join(tr.root, 'events'), join(dir, 'events'), { recursive: true });
    cpSync(join(tr.root, 'done'), join(dir, 'done'), { recursive: true });
    const line = (day: string, parent: number, n: number) => JSON.stringify({ day, kind: 'object.breakup', subjects: [parent, 9001, 9002], t_start: `${day}T00:00:00.000Z`, t_end: `${day}T00:00:00.000Z`, payload: { launch: '1993-036', parentNorad: parent, parentName: 'X', pieces: n, firstDay: day, lastDay: day, names: [] } });
    writeFileSync(join(dir, 'events', 'breakups.jsonl.gz'), gzipSync([line('1965-06-05', 700, 12), line('2026-10-12', 701, 30)].join('\n') + '\n'));
    const count = async () => (await db.pool.query(`SELECT count(*)::int AS n FROM ssa_event WHERE kind = 'object.breakup'`)).rows[0].n as number;
    const r1 = await importEvents(db.pool, dir);
    assert.equal(r1.breakups, 2); assert.equal(await count(), 2);
    await importEvents(db.pool, dir);
    assert.equal(await count(), 2, 'idempotent');
    // the file shrinks: a re-import drops the row that is no longer derived
    writeFileSync(join(dir, 'events', 'breakups.jsonl.gz'), gzipSync(line('1965-06-05', 700, 12) + '\n'));
    await importEvents(db.pool, dir);
    assert.equal(await count(), 1);
    // a ranged import leaves breakups outside the range alone
    writeFileSync(join(dir, 'events', 'breakups.jsonl.gz'), gzipSync([line('1965-06-05', 700, 13), line('2026-10-12', 701, 31)].join('\n') + '\n'));
    await importEvents(db.pool, dir, { from: '2026-10-11', to: '2026-10-12' });
    const rows = (await db.pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, (payload->>'pieces')::int AS pieces FROM ssa_event WHERE kind = 'object.breakup' ORDER BY day`)).rows;
    assert.deepEqual(rows, [{ day: '1965-06-05', pieces: 12 }, { day: '2026-10-12', pieces: 31 }]);
    // object.breakup is not one of a day's change kinds: re-importing the day files does not delete it
    await importEvents(db.pool, dir, { from: '1965-06-05', to: '1965-06-06' });
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ssa_event WHERE kind = 'object.breakup' AND day = '2026-10-12'`)).rows[0].n, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); await db.drop(); }
});
