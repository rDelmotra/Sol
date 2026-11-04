// build-range.ts end to end in child processes (no database): output layout, done markers + restart, sharding gives the same files as one
// process, the production coverage reader accepts the day directories, chain check, empty days, daysBetween / shardOf.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { daysBetween, shardOf } from '../../scripts/history/build-range.js';
import { readManifest, listDays, hasDay, hasLayer, openLayer } from '../../src/ssa/coverage/store.js';
import { chooseLayer, dayCandidates } from '../../src/ssa/passes/candidates.js';
import { circleRegion } from '../../src/ssa/passes/index.js';
import { D1, synthWorld, writeWorld } from './history-helpers.js';
import { runBuildRange } from './history-run.js';

const dir = mkdtempSync(join(tmpdir(), 'histrange-'));
const files = writeWorld(dir, synthWorld());
test.after(() => rmSync(dir, { recursive: true, force: true }));

const common = (out: string, from: string, to: string, extra: string[] = []): string[] => ['--elsets', files.elsets, '--objects', files.objects, '--out', out, '--from', from, '--to', to, '--workers', '2', ...extra];
const eventText = (out: string, d: string): string => gunzipSync(readFileSync(join(out, 'events', d.slice(0, 4), `${d}.jsonl.gz`))).toString();
const tree = (root: string, rel = ''): string[] => readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(root, join(rel, e.name)) : [join(rel, e.name)])).sort();

test('daysBetween / shardOf', () => {
  assert.deepEqual(daysBetween('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  assert.throws(() => daysBetween('2026-03-02', '2026-02-27'));
  const days = daysBetween('2026-10-01', '2026-10-10');
  assert.deepEqual(shardOf(days, 0, 3).concat(shardOf(days, 1, 3), shardOf(days, 2, 3)).sort(), days);
  assert.deepEqual(shardOf(days, 1, 4), ['2026-10-02', '2026-10-06', '2026-10-10']);
  assert.throws(() => shardOf(days, 3, 3));
});

test('layout, markers, restart skips done days and redoes only a missing part, empty day, min-objects', { timeout: 300_000 }, () => {
  const out = join(dir, 'a');
  const r = runBuildRange(common(out, '2026-10-11', D1));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /finished: 2 days done, 0 failed/);
  assert.match(r.stdout, /days\/h/);
  assert.match(r.stdout, /peak RSS/);
  assert.deepEqual(listDays(join(out, 'coverage')), ['2026-10-11', '2026-10-12']);
  for (const d of ['2026-10-11', '2026-10-12']) {
    assert.deepEqual(readdirSync(join(out, 'coverage', d)).sort(), ['day.o3.bin', 'day.o4.bin', 'manifest.json']);
    assert.ok(existsSync(join(out, 'done', 'coverage', '2026', `${d}.json`)) && existsSync(join(out, 'done', 'changes', '2026', `${d}.json`)));
  }
  const m = JSON.parse(readFileSync(join(out, 'done', 'changes', '2026', `${D1}.json`), 'utf8'));
  assert.equal(m.status, 'done'); assert.equal(m.windowDays, 30); assert.deepEqual(m.kinds, ['object.appeared', 'object.disappeared', 'elements.jump', 'close.formation']);
  for (const l of eventText(out, D1).split('\n').filter(Boolean)) assert.deepEqual(Object.keys(JSON.parse(l)), ['day', 'kind', 'subjects', 't_start', 't_end', 'payload']);

  // restart: nothing to do
  const again = runBuildRange(common(out, '2026-10-11', D1));
  assert.equal(again.status, 0);
  assert.match(again.stdout, /0 to do/);
  // remove the events marker of D1: only that part is rebuilt (coverage manifest untouched), the file is identical
  const covMtime = statSync(join(out, 'coverage', D1, 'manifest.json')).mtimeMs, ev = eventText(out, D1);
  rmSync(join(out, 'done', 'changes', '2026', `${D1}.json`));
  rmSync(join(out, 'events', '2026', `${D1}.jsonl.gz`));
  const part = runBuildRange(common(out, '2026-10-11', D1));
  assert.equal(part.status, 0, part.stderr);
  assert.match(part.stdout, /1 to do/);
  assert.equal(statSync(join(out, 'coverage', D1, 'manifest.json')).mtimeMs, covMtime);
  assert.equal(eventText(out, D1), ev);

  // an empty day (before all data): no coverage, an empty events file, both marked; and --min-objects above the catalog size
  const e = runBuildRange(common(out, '2026-08-01', '2026-08-01'));
  assert.equal(e.status, 0, e.stderr);
  assert.equal(hasDay(join(out, 'coverage'), '2026-08-01'), false);
  assert.equal(eventText(out, '2026-08-01'), '');
  assert.equal(JSON.parse(readFileSync(join(out, 'done', 'coverage', '2026', '2026-08-01.json'), 'utf8')).status, 'skipped');
  const big = runBuildRange(common(join(dir, 'big'), D1, D1, ['--parts', 'coverage', '--min-objects', '1000']));
  assert.equal(big.status, 0, big.stderr);
  assert.equal(hasDay(join(dir, 'big', 'coverage'), D1), false);
  assert.equal(existsSync(join(dir, 'big', 'events')), false);
});

test('sharding: shards 0/2 + 1/2 write the same files as one process', { timeout: 300_000 }, () => {
  const one = join(dir, 'one'), sh = join(dir, 'sh');
  assert.equal(runBuildRange(common(one, '2026-10-09', D1)).status, 0);
  assert.equal(runBuildRange(common(sh, '2026-10-09', D1, ['--shard', '0/2'])).status, 0);
  assert.deepEqual(listDays(join(sh, 'coverage')), ['2026-10-09', '2026-10-11']);
  assert.equal(runBuildRange(common(sh, '2026-10-09', D1, ['--shard', '1/2'])).status, 0);
  const a = tree(one).filter((f) => !f.startsWith('done')), b = tree(sh).filter((f) => !f.startsWith('done'));
  assert.deepEqual(b, a);
  for (const f of a) {
    if (f.endsWith('manifest.json')) {
      const x = JSON.parse(readFileSync(join(one, f), 'utf8')), y = JSON.parse(readFileSync(join(sh, f), 'utf8'));
      for (const k of ['norad', 'unindexed', 'skipped', 'layers', 'objects', 'day']) assert.deepEqual(y[k], x[k], `${f} ${k}`);
    } else if (f.endsWith('.gz')) assert.equal(gunzipSync(readFileSync(join(sh, f))).toString(), gunzipSync(readFileSync(join(one, f))).toString(), f);
    else assert.ok(readFileSync(join(sh, f)).equals(readFileSync(join(one, f))), f);
  }
  assert.deepEqual(tree(sh).filter((f) => f.startsWith('done')).length, tree(one).filter((f) => f.startsWith('done')).length);
});

test('the production coverage reader accepts a history day directory (daily layers only)', () => {
  const cov = join(dir, 'one', 'coverage');
  assert.ok(listDays(cov).includes(D1));
  const m = readManifest(cov, D1)!;
  assert.equal(m.day, D1);
  assert.equal(m.dayStartMs, Date.parse(D1 + 'T00:00:00Z'));
  assert.ok(m.objects > 40 && m.norad.length === m.objects);
  assert.equal(hasLayer(cov, D1, { gran: 'hour', order: 4 }), false);
  assert.equal(hasLayer(cov, D1, { gran: 'day', order: 4 }), true);
  const l3 = openLayer(cov, D1, { gran: 'day', order: 3 }), l4 = openLayer(cov, D1, { gran: 'day', order: 4 });
  assert.equal(l3.n, m.objects); assert.equal(l4.n, m.objects);
  const dl = chooseLayer(cov, m)!;
  assert.deepEqual(dl.layer, { gran: 'day', order: 4 });
  // a query: a big circle finds candidates, a tiny one far from every orbit finds fewer or none
  const c = dayCandidates(cov, m, circleRegion(0, 0, 3000), Date.parse(D1 + 'T00:00:00Z'), Date.parse(D1 + 'T00:00:00Z') + 86_400_000, dl);
  assert.ok(c.windows.size > 0 && c.stats.lists > 0);
});

test('chain check mode prints a row per year with pairs and a finite median', { timeout: 120_000 }, () => {
  const r = runBuildRange(['--check-chain', '--elsets', files.elsets, '--years', '2026', '--start', '10-07', '--window-days', '6', '--sample', '1000', '--json', join(dir, 'chain.json')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^2026 /m);
  const rep = JSON.parse(readFileSync(join(dir, 'chain.json'), 'utf8')) as Array<{ year: number; pairs: number; medianKm: number }>;
  assert.equal(rep[0]!.year, 2026);
  assert.ok(rep[0]!.pairs > 100 && Number.isFinite(rep[0]!.medianKm));
});
