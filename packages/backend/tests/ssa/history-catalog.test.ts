// Catalog-as-of-day from per-day element-set files: rules (latest set per object inside the staleness window, decayed objects out),
// the rolling mode equals the from-scratch mode, the change detection on file catalogs, the era table, the chain check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogAsOfDay, FileCatalog, regimeOf, windowDayList, firstSeenOf } from '../../src/ssa/history/catalog-files.js';
import { readElsetDay, loadObjects } from '../../src/ssa/history/elset-files.js';
import { deriveDayFromCatalogs, eventLine, eventRow } from '../../src/ssa/history/derive-files.js';
import { ERA_TABLE, eraFor, validateEraTable } from '../../src/ssa/history/era.js';
import { chainPairs, summarizeChain } from '../../src/ssa/history/chain.js';
import { classifyRegime } from '../../src/services/classifier.js';
import { D0, D1, DAY, dms, iso, synthWorld, writeWorld } from './history-helpers.js';

const world = synthWorld();
const dir = mkdtempSync(join(tmpdir(), 'hist-'));
const files = writeWorld(dir, world);
const objects = loadObjects(files.objects);
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ids = (c: Array<{ noradId: number }>): number[] => c.map((o) => o.noradId);

test('element-set files round-trip: every set of the day, parsed epoch, ordered', () => {
  const day = iso(dms(D1) - 2 * DAY).slice(0, 10);
  const sets = readElsetDay(files.elsets, day);
  const want = world.sets.filter((s) => iso(s.epochMs).slice(0, 10) === day);
  assert.equal(sets.length, want.length);
  assert.deepEqual(sets.map((s) => [s.noradId, s.epochMs]), want.map((s) => [s.noradId, s.epochMs]));
  assert.equal(sets[0]!.omm.NORAD_CAT_ID, sets[0]!.noradId);
  assert.deepEqual(readElsetDay(files.elsets, '1999-01-01'), []);
  assert.equal(objects.size, world.objects.length);
});

test('catalog as of D1: latest set per object, window, stale and decayed objects out, new object in', () => {
  const c0 = catalogAsOfDay(files.elsets, objects, D0, 30), c1 = catalogAsOfDay(files.elsets, objects, D1, 30);
  assert.deepEqual(ids(c1), [...ids(c1)].sort((a, b) => a - b));
  assert.ok(ids(c0).includes(150) && !ids(c1).includes(150), '150 goes stale between D0 and D1');
  assert.ok(ids(c0).includes(400) && !ids(c1).includes(400), '400 decayed on D0: still catalogued on D0, gone on D1');
  assert.ok(!ids(c0).includes(200) && ids(c1).includes(200), '200 appears on D1');
  assert.ok(ids(c1).includes(500), 'sparse object stays within the window');
  const o100 = c1.find((o) => o.noradId === 100)!;
  assert.equal(o100.omm.EPOCH, iso(dms(D1) + 3 * 3_600_000), 'the latest set of 100, not the 40-day-old one');
  assert.equal(o100.name, 'SYN-100'.replace('SYN-100', o100.name)); // name from the objects file when set, else OBJECT_NAME
  assert.equal(c1.find((o) => o.noradId === 100)!.name, 'SYN-100');
  assert.equal(c1.find((o) => o.noradId === 101)!.name, 'NAME-101');
  assert.equal(c1.find((o) => o.noradId === 101)!.launchDate, '2020-01-01');
  assert.ok(o100.perigee! > 0 && o100.apogee! > o100.perigee!);
  assert.equal(o100.regime, 'LEO');
  // a longer window brings the 40-day-old... only the sets inside it; a 10-day window drops 150 and 500 from D0 too
  assert.ok(!ids(catalogAsOfDay(files.elsets, objects, D0, 10)).includes(500));
  assert.ok(ids(catalogAsOfDay(files.elsets, objects, D1, 60)).includes(150));
  // epoch must be before the END of the day: a set on D1 is not in D0's catalog (the latest set of 101 differs)
  assert.notEqual(catalogAsOfDay(files.elsets, objects, D0, 30).find((o) => o.noradId === 101)!.omm.MEAN_MOTION, c1.find((o) => o.noradId === 101)!.omm.MEAN_MOTION);
});

test('window boundary: the window is whole days [D+1-window, D]; 500 has its only set 20 days (+1 s) before D1', () => {
  assert.equal(windowDayList('2026-10-12', 3).join(), '2026-10-12,2026-10-11,2026-10-10');
  assert.ok(!ids(catalogAsOfDay(files.elsets, objects, D1, 20)).includes(500), 'epoch < D1+1d-20d: out');
  assert.ok(ids(catalogAsOfDay(files.elsets, objects, D1, 21)).includes(500), 'inside a 21-day window');
});

test('rolling catalog equals the from-scratch catalog for consecutive, spaced, repeated and backwards days; reads far fewer files', () => {
  const days: string[] = [];
  for (let k = 8; k >= 0; k--) days.push(iso(dms(D1) - k * DAY).slice(0, 10));
  const fc = new FileCatalog(files.elsets, objects);
  for (const d of days) assert.deepEqual(fc.asOf(d, 30), catalogAsOfDay(files.elsets, objects, d, 30), d);
  assert.equal(fc.rebuilds, 1);
  assert.ok(fc.filesRead < 30 + 9, `read ${fc.filesRead} files`);
  // repeated day, then a spaced jump (3 days), then back in time (rebuild), then a different window (rebuild)
  assert.deepEqual(fc.asOf(D1, 30), catalogAsOfDay(files.elsets, objects, D1, 30));
  const fc2 = new FileCatalog(files.elsets, objects);
  for (const d of [days[0]!, days[3]!, days[7]!, days[2]!, days[8]!]) assert.deepEqual(fc2.asOf(d, 30), catalogAsOfDay(files.elsets, objects, d, 30), d);
  assert.deepEqual(fc2.asOf(D1, 12), catalogAsOfDay(files.elsets, objects, D1, 12));
  // a gap longer than the window rebuilds
  const fc3 = new FileCatalog(files.elsets, objects);
  fc3.asOf('2026-09-01', 5);
  assert.deepEqual(fc3.asOf(D0, 5), catalogAsOfDay(files.elsets, objects, D0, 5));
  assert.equal(fc3.rebuilds, 2);
});

test('regimeOf equals services/classifier classifyRegime over a grid of periods and eccentricities', () => {
  for (const p of [90, 100, 127.9, 128, 400, 1379, 1380, 1436, 1500, 1501, 2000]) for (const e of [0, 0.001, 0.09, 0.1, 0.24, 0.25, 0.7]) assert.equal(regimeOf(p, e), classifyRegime(p, e), `${p} ${e}`);
});

test('change detection on file catalogs: appeared, disappeared, jump, formation; thresholds by era; event lines round-trip', () => {
  const prev = catalogAsOfDay(files.elsets, objects, D0, 30), cur = catalogAsOfDay(files.elsets, objects, D1, 30);
  const r = deriveDayFromCatalogs(prev, cur, D1, { firstSeen: (id) => firstSeenOf(objects, id) });
  const of = (k: string) => r.rows.filter((x) => x.kind === k);
  assert.deepEqual(of('object.appeared').map((x) => [x.subjects[0], x.payload.cls]), [[200, 'new_launch']]);
  assert.deepEqual(of('object.disappeared').map((x) => x.subjects[0]), [150, 400]);
  assert.deepEqual(of('elements.jump').map((x) => x.subjects[0]), [101]);
  assert.deepEqual(of('close.formation').map((x) => x.subjects), [[300, 301]]);
  assert.deepEqual(r.kinds, ['object.appeared', 'object.disappeared', 'elements.jump', 'close.formation']);
  // an era with a huge jump threshold finds no jump; skipFormation drops the kind
  assert.equal(deriveDayFromCatalogs(prev, cur, D1, { jumpDposKm: 1e6 }).rows.filter((x) => x.kind === 'elements.jump').length, 0);
  const sf = deriveDayFromCatalogs(prev, cur, D1, { skipFormation: true });
  assert.ok(!sf.kinds.includes('close.formation'));
  // lines
  for (const row of r.rows) {
    const line = JSON.parse(JSON.stringify(eventLine(D1, row)));
    assert.deepEqual(Object.keys(line), ['day', 'kind', 'subjects', 't_start', 't_end', 'payload']);
    assert.equal(line.day, D1);
    // times are written as ISO strings (whole milliseconds); the SGP4 epoch has sub-millisecond digits
    const back = eventRow(line);
    assert.ok(Math.abs(back.tStart - row.tStart) < 1 && Math.abs(back.tEnd - row.tEnd) < 1);
    assert.deepEqual({ ...back, tStart: 0, tEnd: 0 }, JSON.parse(JSON.stringify({ ...row, tStart: 0, tEnd: 0 })));
  }
});

test('era table: lookup by year, validation, placeholders end in the production values', () => {
  assert.equal(eraFor('1959-02-01').fromYear, 1959);
  assert.equal(eraFor('1969-12-31').fromYear, 1959);
  assert.equal(eraFor('1970-01-01').fromYear, 1970);
  assert.equal(eraFor('2026-10-12').windowDays, 30);
  assert.equal(eraFor('1900-01-01').fromYear, 1959);
  assert.throws(() => validateEraTable([{ fromYear: 2000, windowDays: 30, jumpDposKm: 1, jumpDaKm: 1 }, { fromYear: 1990, windowDays: 30, jumpDposKm: 1, jumpDaKm: 1 }]));
  assert.throws(() => validateEraTable([]));
  assert.equal(validateEraTable(ERA_TABLE).length, ERA_TABLE.length);
});

test('chain check: pairs of consecutive sets of one object, SGP4 to the next epoch', () => {
  const sets = world.sets.filter((s) => s.noradId >= 100 && s.noradId < 140).map((s) => ({ noradId: s.noradId, epochMs: s.epochMs, omm: s.omm }));
  const { pairs, failed } = chainPairs(sets, 5);
  assert.equal(failed, 0);
  assert.ok(pairs.length > 100);
  const s = summarizeChain(pairs, failed);
  assert.ok(s.medianKm > 0 && s.p95Km >= s.medianKm && Number.isFinite(s.medianGapDays));
  // identical consecutive sets of one object (same elements, later epoch) are NOT zero (the epoch moved): a perfectly consistent pair is
  const a = world.sets.find((x) => x.noradId === 300)!;
  const bomm = { ...a.omm, EPOCH: iso(a.epochMs + 3_600_000) };
  const { pairs: p2 } = chainPairs([a, { noradId: 300, epochMs: a.epochMs + 3_600_000, omm: bomm }], 5);
  assert.equal(p2.length, 1);
  assert.ok(p2[0]!.dposKm > 0);
});
