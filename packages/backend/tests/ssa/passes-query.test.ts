// The pass query end to end on a synthetic world: candidates from the star-map lists + exact refine must find everything a brute-force
// sweep finds (recall 100% at 10 s), and nothing the exact scan does not confirm. Named regions, circles (also across the antimeridian),
// windows that start / end inside a day, missing days (listed; filled by brute force when asked and at most 2), window limits, limit /
// norad options, caching, and the one-at-a-time guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { passesOver, passedOverSet, clearPassesCaches, PassesError, MAX_WINDOW_DAYS, mergePieces } from '../../src/ssa/passes/index.js';
import { resolveRegion, circleRegion } from '../../src/ssa/passes/index.js';
import { writeFileSync } from 'node:fs';
import { DB_URL } from './db-helper.js';
import { makeFixture, truthFor, dayMs, DAY_MS, type Fixture } from './passes-fixture.js';

const skip = DB_URL ? false : 'DATABASE_URL not set';
const DAYS = ['2026-10-10', '2026-10-11', '2026-10-12'];
const NOW = Date.parse('2026-10-20T03:00:00Z');
const base = { nowMs: NOW, workers: 2 };

let fx: Fixture;
async function withFixture(fn: () => Promise<void>): Promise<void> {
  fx = await makeFixture(DAYS, ['2026-10-10', '2026-10-11']); // the 12th has element sets but no coverage
  try { clearPassesCaches(); await fn(); } finally { await fx.cleanup(); }
}

test('who passed: the same objects as a brute-force sweep (named region, circles incl. the antimeridian), with exact pass times', { skip, timeout: 600_000 }, async () => {
  await withFixture(async () => {
    const from = dayMs('2026-10-10'), to = dayMs('2026-10-12');
    const regions = [resolveRegion('india'), circleRegion(30, 20, 3000), circleRegion(-17.5, 179.5, 1500), circleRegion(48.85, 2.35, 500)];
    let anyFound = 0;
    for (const region of regions) {
      const truth = await truthFor(fx.pool, region, ['2026-10-10', '2026-10-11'], from, to);
      const r = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, limit: 200 });
      const got = new Set(r.allIds);
      // recall at 10 s resolution: nothing the sweep sees is missing
      for (const id of truth.sampled) assert.ok(got.has(id), `${region.id}: object ${id} seen by the 10 s sweep is missing`);
      // precision: exactly what the exact scan over the whole days finds
      assert.deepEqual([...got].sort((a, b) => a - b), [...truth.refined].sort((a, b) => a - b), region.id);
      assert.equal(r.totalObjects, got.size);
      assert.deepEqual(r.missingDays, []);
      // pass intervals: identical to the exact scan of whole days (same samples), pieces joined across midnight
      for (const o of r.objects) {
        assert.deepEqual(o.passes, mergePieces(truth.passes.get(o.noradId)!), `${region.id} object ${o.noradId}`);
        for (const [a, b] of o.passes) assert.ok(a >= from && b <= to && a <= b); // windows are inclusive of both ends
      }
      assert.equal(r.objects.length, got.size);
      anyFound += got.size;
    }
    assert.ok(anyFound >= 20, `the fixture should have passes (${anyFound})`);
  });
});

test('options: limit lists the lowest NORAD ids but counts all; norad narrows to one object; limit 0 is the total only', { skip, timeout: 300_000 }, async () => {
  await withFixture(async () => {
    const from = dayMs('2026-10-10'), to = dayMs('2026-10-12');
    const region = circleRegion(30, 20, 3000);
    const all = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, limit: 500 });
    assert.ok(all.totalObjects > 6);
    const some = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, limit: 5 });
    assert.equal(some.totalObjects, all.totalObjects);
    assert.deepEqual(some.objects.map((o) => o.noradId), all.allIds!.slice(0, 5));
    assert.deepEqual(some.objects, all.objects.slice(0, 5));
    const one = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, norad: all.allIds![2]! });
    assert.deepEqual(one.objects, [all.objects[2]]);
    assert.equal(one.totalObjects, 1);
    const none = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, norad: 999999 });
    assert.deepEqual([none.totalObjects, none.objects.length], [0, 0]);
    const total = await passedOverSet(fx.pool, region, from, to, { ...base, dir: fx.dir });
    assert.deepEqual([...total.ids].sort((a, b) => a - b), all.allIds);
  });
});

test('windows inside a day: candidates and passes are clipped to [from, to]', { skip, timeout: 300_000 }, async () => {
  await withFixture(async () => {
    const from = dayMs('2026-10-10') + 5 * 3_600_000 + 17 * 60_000, to = dayMs('2026-10-10') + 9 * 3_600_000 + 1234;
    const region = circleRegion(30, 20, 3000);
    const truth = await truthFor(fx.pool, region, ['2026-10-10'], from, to);
    const r = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, limit: 500 });
    for (const id of truth.sampled) assert.ok(r.allIds!.includes(id));
    assert.deepEqual(r.allIds, [...truth.refined].sort((a, b) => a - b));
    for (const o of r.objects) for (const [a, b] of o.passes) assert.ok(a >= from && b <= to, `${a} ${b}`);
    assert.ok(r.objects.length > 0);
  });
});

test('missing days are listed, never silently skipped; fill=true computes up to 2 of them by brute force', { skip, timeout: 600_000 }, async () => {
  await withFixture(async () => {
    const from = dayMs('2026-10-10'), to = dayMs('2026-10-13');
    const region = circleRegion(30, 20, 3000);
    const r = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, limit: 500 });
    assert.deepEqual(r.missingDays, ['2026-10-12']);
    assert.deepEqual(r.filledDays, []);
    const two = await truthFor(fx.pool, region, ['2026-10-10', '2026-10-11'], from, to);
    assert.deepEqual(r.allIds, [...two.refined].sort((a, b) => a - b)); // only the covered days
    // fill: the 12th is propagated from its own element sets
    const f = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, limit: 500, fill: true });
    assert.deepEqual(f.missingDays, []);
    assert.deepEqual(f.filledDays, ['2026-10-12']);
    const three = await truthFor(fx.pool, region, DAYS, from, to);
    assert.deepEqual(f.allIds, [...three.refined].sort((a, b) => a - b));
    assert.equal(f.layers['2026-10-12'], 'brute-force');
    assert.match(f.layers['2026-10-10']!, /^hour\.o4$/);
    // more than two missing days: listed only
    const wide = await passesOver(fx.pool, region, dayMs('2026-10-05'), to, { ...base, dir: fx.dir, limit: 0, fill: true });
    assert.deepEqual(wide.missingDays, ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12']);
    assert.deepEqual(wide.filledDays, []);
  });
});

test('the daily layer is used when the hourly one has been pruned, and finds the same objects (more candidates)', { skip, timeout: 300_000 }, async () => {
  await withFixture(async () => {
    const { pruneHourly, clearStoreCaches } = await import('../../src/ssa/coverage/store.js');
    const from = dayMs('2026-10-10'), to = dayMs('2026-10-12');
    const region = circleRegion(30, 20, 3000);
    const hourly = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, limit: 500 });
    clearPassesCaches();
    assert.deepEqual(pruneHourly(fx.dir, 1, Date.parse('2026-12-01T00:00:00Z')), ['2026-10-10', '2026-10-11']);
    clearStoreCaches();
    const daily = await passesOver(fx.pool, region, from, to, { ...base, dir: fx.dir, limit: 500 });
    assert.deepEqual(daily.layers, { '2026-10-10': 'day.o4', '2026-10-11': 'day.o4' });
    assert.deepEqual(daily.allIds, hourly.allIds);
    assert.deepEqual(daily.objects, hourly.objects);
    assert.ok(daily.stats.candidateObjectDays >= hourly.stats.candidateObjectDays);
  });
});

test('window rules: at most 90 days, from before to, the future is cut at now, results are cached for settled windows', { skip, timeout: 300_000 }, async () => {
  await withFixture(async () => {
    const region = circleRegion(30, 20, 3000);
    await assert.rejects(passesOver(fx.pool, region, dayMs('2026-10-10'), dayMs('2026-10-10'), { ...base, dir: fx.dir }), (e: unknown) => e instanceof PassesError && e.code === 'bad-window');
    await assert.rejects(passesOver(fx.pool, region, dayMs('2026-01-01'), dayMs('2026-10-10'), { ...base, dir: fx.dir }), (e: unknown) => e instanceof PassesError && e.code === 'too-long');
    assert.equal(MAX_WINDOW_DAYS, 90);
    // a window that ends after "now": cut
    const r = await passesOver(fx.pool, region, dayMs('2026-10-19'), dayMs('2026-10-25'), { ...base, dir: fx.dir, limit: 0 });
    assert.equal(r.clippedToNow, true);
    assert.equal(r.toMs, NOW);
    assert.deepEqual(r.missingDays, ['2026-10-19', '2026-10-20']);
    // entirely in the future: nothing
    const f = await passesOver(fx.pool, region, NOW + DAY_MS, NOW + 2 * DAY_MS, { ...base, dir: fx.dir, limit: 0 });
    assert.deepEqual([f.totalObjects, f.clippedToNow, f.missingDays], [0, true, []]);
    // cache: the second identical settled query returns the very same object, instantly
    const a = await passesOver(fx.pool, region, dayMs('2026-10-10'), dayMs('2026-10-12'), { ...base, dir: fx.dir });
    const t0 = performance.now();
    const b = await passesOver(fx.pool, region, dayMs('2026-10-10'), dayMs('2026-10-12'), { ...base, dir: fx.dir });
    assert.equal(a, b);
    assert.ok(performance.now() - t0 < 50);
    // a window with missing days is cached too (briefly: coverage may arrive), and still lists them
    const m1 = await passesOver(fx.pool, region, dayMs('2026-10-08'), dayMs('2026-10-12'), { ...base, dir: fx.dir, limit: 3 });
    const m2 = await passesOver(fx.pool, region, dayMs('2026-10-08'), dayMs('2026-10-12'), { ...base, dir: fx.dir, limit: 3 });
    assert.equal(m1, m2);
    assert.deepEqual(m1.missingDays, ['2026-10-08', '2026-10-09']);
    // a corrupted day is not an answer: unreadable layer -> error, not a silent gap
    writeFileSync(`${fx.dir}/2026-10-11/hour.o4.bin`, new Uint8Array(40));
    const { clearStoreCaches } = await import('../../src/ssa/coverage/store.js');
    clearStoreCaches(); clearPassesCaches();
    await assert.rejects(passesOver(fx.pool, region, dayMs('2026-10-10'), dayMs('2026-10-12'), { ...base, dir: fx.dir }));
  });
});

test('merging pass pieces across midnight', () => {
  assert.deepEqual(mergePieces([100, 200, 86_400_000 - 5000, 86_400_000 - 1000, 86_400_000, 86_400_000 + 3000]), [[100, 200], [86_400_000 - 5000, 86_400_000 + 3000]]);
  assert.deepEqual(mergePieces([]), []);
});
