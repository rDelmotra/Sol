// object.breakup: the pure deriver (clusters, windows, thresholds, parent, returned objects), the files round trip, the DB replace
// (idempotent), and the real 2009 sample when it is on this machine (HISTORY_SAMPLE_DIR; skipped otherwise).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { deriveBreakups, launchOf, type AppearedRef } from '../../src/ssa/history/breakup.js';
import { readAppeared, readBreakupLines, writeBreakups, breakupLine } from '../../src/ssa/history/breakup-files.js';
import { replaceBreakups, loadAppearedFromDb } from '../../src/ssa/history/breakup-db.js';
import { loadObjects, type ObjectMeta } from '../../src/ssa/history/elset-files.js';
import { createTestDb, DB_URL } from './db-helper.js';

const day = (n: number): string => new Date(Date.UTC(2009, 1, 1) + n * 86_400_000).toISOString().slice(0, 10);
const meta = (id: number, o: Partial<ObjectMeta>): ObjectMeta => ({ noradId: id, name: `OBJ-${id}`, objectType: 'debris', rcsSize: null, launchDate: null, decayDate: null, intlDesignator: null, ...o });

function world(): { objects: Map<number, ObjectMeta>; appeared: AppearedRef[] } {
  const objects = new Map<number, ObjectMeta>();
  const appeared: AppearedRef[] = [];
  // launch 1993-036: a payload (the parent, tracking ends at the breakup) + a rocket body, and 25 debris pieces over 20 days
  objects.set(22675, meta(22675, { name: 'COSMOS 2251', objectType: 'satellite', intlDesignator: '1993-036A', lastEpoch: `${day(9)}T10:00:00.000Z`, decayDate: day(9) }));
  objects.set(22676, meta(22676, { name: 'COSMOS 2251 R/B', objectType: 'rocket_body', intlDesignator: '1993-036B', lastEpoch: '2002-01-01T00:00:00.000Z' }));
  for (let i = 0; i < 25; i++) { const id = 33000 + i; objects.set(id, meta(id, { name: `COSMOS 2251 DEB${i < 3 ? '' : ' ' + i}`, intlDesignator: `1993-036${String.fromCharCode(67 + (i % 20))}${i >= 20 ? 'A' : ''}` })); appeared.push({ noradId: id, day: day(10 + (i % 20)), cls: 'newly_cataloged' }); }
  // launch 1997-051: 12 pieces in a burst, then 5 more 200 days later (a second, too small cluster)
  objects.set(24946, meta(24946, { name: 'IRIDIUM 33', objectType: 'satellite', intlDesignator: '1997-051A' }));
  for (let i = 0; i < 12; i++) { const id = 34000 + i; objects.set(id, meta(id, { name: 'IRIDIUM 33 DEB', intlDesignator: `1997-051${String.fromCharCode(66 + i)}` })); appeared.push({ noradId: id, day: day(12 + i), cls: 'newly_cataloged' }); }
  for (let i = 0; i < 5; i++) { const id = 34100 + i; objects.set(id, meta(id, { name: 'IRIDIUM 33 DEB', intlDesignator: `1997-051Z${i}` })); appeared.push({ noradId: id, day: day(260 + i), cls: 'newly_cataloged' }); }
  // too few pieces; pieces that are 'returned'; a piece that is not debris; debris without a designator
  for (let i = 0; i < 9; i++) { const id = 35000 + i; objects.set(id, meta(id, { intlDesignator: `1999-025${String.fromCharCode(65 + i)}` })); appeared.push({ noradId: id, day: day(5), cls: 'newly_cataloged' }); }
  for (let i = 0; i < 15; i++) { const id = 36000 + i; objects.set(id, meta(id, { intlDesignator: `1980-001${String.fromCharCode(65 + i)}` })); appeared.push({ noradId: id, day: day(7), cls: 'returned' }); }
  for (let i = 0; i < 15; i++) { const id = 37000 + i; objects.set(id, meta(id, { objectType: 'satellite', intlDesignator: `2020-001${String.fromCharCode(65 + i)}` })); appeared.push({ noradId: id, day: day(8), cls: 'new_launch' }); }
  for (let i = 0; i < 15; i++) { const id = 38000 + i; objects.set(id, meta(id, {})); appeared.push({ noradId: id, day: day(8), cls: 'newly_cataloged' }); }
  // an object appearing twice (disappeared and came back): counted once, on its first day
  appeared.push({ noradId: 33000, day: day(80), cls: 'returned' });
  return { objects, appeared };
}

test('launchOf', () => {
  assert.equal(launchOf('1997-051AB'), '1997-051');
  assert.equal(launchOf('2009-005'), '2009-005');
  assert.equal(launchOf(null), null);
  assert.equal(launchOf('97051A'), null);
});

test('deriver: clusters by launch and window, thresholds, parent, payload, determinism', () => {
  const { objects, appeared } = world();
  const ev = deriveBreakups(appeared, objects);
  assert.deepEqual(ev.map((e) => e.payload.launch), ['1993-036', '1997-051']);
  const [cos, iri] = ev as [typeof ev[0], typeof ev[0]];
  assert.equal(cos.kind, 'object.breakup');
  assert.equal(cos.day, day(10)); assert.equal(cos.payload.firstDay, day(10)); assert.equal(cos.payload.lastDay, day(29));
  assert.equal(cos.payload.pieces, 25);
  assert.equal(cos.payload.parentNorad, 22675, 'the payload whose tracking ended at the breakup, not the rocket body');
  assert.equal(cos.payload.parentName, 'COSMOS 2251');
  assert.deepEqual(cos.subjects.slice(0, 3), [22675, 33000, 33001]);
  assert.equal(cos.subjects.length, 26);
  assert.ok(cos.payload.names.length <= 5 && cos.payload.names.every((n) => n.includes('COSMOS 2251')));
  assert.equal(cos.tStart, Date.parse(day(10) + 'T00:00:00Z')); assert.equal(cos.tEnd, Date.parse(day(29) + 'T00:00:00Z'));
  // Iridium: the burst of 12; the later 5 are a separate (too small) cluster, and the only non-debris object is the parent
  assert.equal(iri.payload.pieces, 12); assert.equal(iri.payload.parentNorad, 24946);
  // thresholds
  assert.equal(deriveBreakups(appeared, objects, { minPieces: 13 }).length, 1);
  assert.deepEqual(deriveBreakups(appeared, objects, { minPieces: 5 }).map((e) => [e.payload.launch, e.payload.pieces]), [['1999-025', 9], ['1993-036', 25], ['1997-051', 12], ['1997-051', 5]]);
  // a window long enough to chain the late 5 onto the burst
  const wide = deriveBreakups(appeared, objects, { windowDays: 400 }).find((e) => e.payload.launch === '1997-051')!;
  assert.equal(wide.payload.pieces, 17);
  // input order does not matter
  assert.deepEqual(deriveBreakups([...appeared].reverse(), objects), ev);
});

test('deriver: a launch with no non-debris object takes its earliest piece as parent; an unknown piece is ignored', () => {
  const objects = new Map<number, ObjectMeta>();
  const appeared: AppearedRef[] = [];
  for (let i = 0; i < 10; i++) { objects.set(500 + i, meta(500 + i, { intlDesignator: `1970-100${String.fromCharCode(65 + i)}` })); appeared.push({ noradId: 500 + i, day: day(i), cls: 'newly_cataloged' }); }
  appeared.push({ noradId: 999, day: day(1), cls: 'newly_cataloged' }); // not in the objects file
  const [e] = deriveBreakups(appeared, objects);
  assert.equal(e!.payload.pieces, 10); assert.equal(e!.payload.parentNorad, 500);
  assert.equal(e!.subjects.length, 10, 'the parent is one of the pieces: listed once');
});

test('files: appeared events in, breakups.jsonl.gz out (rows in the ssa_event shape), range filter', () => {
  const { objects, appeared } = world();
  const root = mkdtempSync(join(tmpdir(), 'brk-'));
  try {
    const byDay = new Map<string, string[]>();
    for (const a of appeared) (byDay.get(a.day) ?? byDay.set(a.day, []).get(a.day)!).push(JSON.stringify({ day: a.day, kind: 'object.appeared', subjects: [a.noradId], t_start: `${a.day}T01:00:00.000Z`, t_end: `${a.day}T01:00:00.000Z`, payload: { cls: a.cls } }));
    for (const [d, ls] of byDay) {
      ls.push(JSON.stringify({ day: d, kind: 'elements.jump', subjects: [1], t_start: `${d}T01:00:00.000Z`, t_end: `${d}T01:00:00.000Z`, payload: {} }));
      mkdirSync(join(root, 'events', d.slice(0, 4)), { recursive: true });
      writeFileSync(join(root, 'events', d.slice(0, 4), `${d}.jsonl.gz`), gzipSync(ls.join('\n') + '\n'));
    }
    assert.equal(readAppeared(root).length, appeared.length, 'only object.appeared lines');
    assert.equal(readAppeared(root, day(10), day(12)).length, appeared.filter((a) => a.day >= day(10) && a.day <= day(12)).length);
    const evs = writeBreakups(root, objects);
    assert.deepEqual(evs, deriveBreakups(appeared, objects));
    const lines = readBreakupLines(root);
    assert.deepEqual(lines, evs.map(breakupLine));
    assert.deepEqual(Object.keys(lines[0]!), ['day', 'kind', 'subjects', 't_start', 't_end', 'payload']);
    assert.equal(lines[0]!.t_start, `${day(10)}T00:00:00.000Z`);
    assert.deepEqual(readBreakupLines(mkdtempSync(join(tmpdir(), 'brk-empty-'))), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DB: replaceBreakups is idempotent and replaces only its range; loadAppearedFromDb reads the appeared events', { skip: DB_URL ? false : 'DATABASE_URL not set' }, async () => {
  const db = await createTestDb();
  try {
    const { objects, appeared } = world();
    const lines = deriveBreakups(appeared, objects).map(breakupLine);
    const r1 = await replaceBreakups(db.pool, lines);
    assert.deepEqual(r1, { deleted: 0, inserted: 2 });
    const r2 = await replaceBreakups(db.pool, lines);
    assert.deepEqual(r2, { deleted: 2, inserted: 2 });
    const { rows } = await db.pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, subjects, payload FROM ssa_event WHERE kind = 'object.breakup' ORDER BY day`);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].payload.parentNorad, 22675); assert.equal(rows[0].subjects[0], 22675); assert.equal(rows[0].day, day(10));
    // a range replace leaves the other rows alone
    await replaceBreakups(db.pool, [], { from: day(11), to: day(60) });
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ssa_event WHERE kind = 'object.breakup'`)).rows[0].n, 1);
    // appeared events -> refs
    await db.pool.query(`INSERT INTO ssa_event (day, kind, subjects, payload) VALUES ('2009-02-11', 'object.appeared', '{33000}', '{"cls":"newly_cataloged"}'), ('2009-02-12', 'object.appeared', '{33001}', '{}'), ('2009-02-13', 'elements.jump', '{5}', '{}')`);
    const refs = await loadAppearedFromDb(db.pool);
    assert.deepEqual(refs, [{ noradId: 33000, day: '2009-02-11', cls: 'newly_cataloged' }, { noradId: 33001, day: '2009-02-12', cls: null }]);
    assert.equal((await loadAppearedFromDb(db.pool, { from: '2009-02-12' })).length, 1);
  } finally { await db.drop(); }
});

const SAMPLE = process.env.HISTORY_SAMPLE_DIR ?? '/tmp/claude-0/-home-user-Sol/34cdd254-400f-543c-9df5-b3a19e984195/scratchpad/hist/sample';
const haveSample = existsSync(join(SAMPLE, 'objects.jsonl.gz')) && existsSync(join(SAMPLE, 'events', '2009', '2009-03-10.jsonl.gz'));

test('2009 sample: Iridium 33 (1997-051) and Cosmos 2251 (1993-036) debris clusters, parents, first days', { skip: haveSample ? false : 'sample not on this machine', timeout: 120_000 }, () => {
  const objects = loadObjects(join(SAMPLE, 'objects.jsonl.gz'));
  const ev = deriveBreakups(readAppeared(SAMPLE, '2009-02-01'), objects); // after the first month: the sample has no 2008 element sets
  const iri = ev.find((e) => e.payload.launch === '1997-051'), cos = ev.find((e) => e.payload.launch === '1993-036');
  assert.ok(iri && cos, `found ${ev.map((e) => e.payload.launch).join(',')}`);
  assert.equal(iri.payload.parentNorad, 24946); assert.equal(cos.payload.parentNorad, 22675);
  assert.ok(iri.payload.pieces >= 100 && cos.payload.pieces >= 100, `${iri.payload.pieces} / ${cos.payload.pieces}`);
  assert.ok(iri.payload.firstDay >= '2009-02-10' && iri.payload.firstDay <= '2009-02-20');
  assert.ok(cos.payload.firstDay >= '2009-02-10' && cos.payload.firstDay <= '2009-02-20');
});
