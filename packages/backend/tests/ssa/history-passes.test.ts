// The pass query over history days: coverage from <history root>/coverage (fallback when SSA_COVERAGE_DIR has not the day), the exact refine
// with the element sets of <root>/elsets and the manifest's SGP list. No database is needed (the fake pool fails the test if it is used
// for a history day); the live directory wins over history for a day both have.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { passesOver, passedOverSet, clearPassesCaches, mergePieces, PassesError, circleRegion } from '../../src/ssa/passes/index.js';
import { getHistoryStore, clearHistoryStores } from '../../src/ssa/history/store.js';
import { readManifest, clearStoreCaches } from '../../src/ssa/coverage/store.js';
import { regionFlags, passesIn } from '../../src/ssa/coverage/scan.js';
import { makeProp, newStats } from '../../src/ssa/coverage/runs.js';
import type { Region } from '../../src/ssa/coverage/region.js';
import { buildTestRoot } from './history-root.js';
import { D0, D1 } from './history-helpers.js';
import { historyCoverageDir } from '../../src/ssa/config.js';

const DAY_MS = 86_400_000;
const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z');
const NOW = Date.parse('2026-11-01T00:00:00Z');
const tr = buildTestRoot();
const emptyLive = mkdtempSync(join(tmpdir(), 'live-empty-'));
test.after(() => { rmSync(emptyLive, { recursive: true, force: true }); clearHistoryStores(); tr.cleanup(); });

let poolCalls = 0;
const fakePool = { query: async () => { poolCalls++; throw new Error('the database must not be used for history days'); } } as unknown as Pool;
const base = { nowMs: NOW, workers: 2, limit: 500 };

/** Exact reference: every object of the day's catalog (the manifest's model), the exact scan over the whole day. */
function truth(region: Region, day: string, fromMs: number, toMs: number): Map<number, number[]> {
  const m = readManifest(historyCoverageDir(tr.root)!, day)!;
  const sgp = new Set(m.propagators?.sgp ?? []);
  const out = new Map<number, number[]>();
  const a = Math.max(fromMs, dayMs(day)), b = Math.min(toMs, dayMs(day) + DAY_MS);
  for (const o of getHistoryStore(tr.root).dayCatalog(day)) {
    const p = makeProp(o.omm, sgp.has(o.noradId) ? 'sgp' : undefined);
    if (!p) continue;
    const iv = passesIn(p, region, [a, b], newStats());
    if (iv.length) out.set(o.noradId, iv);
  }
  void regionFlags;
  return out;
}

test('modern history days (SGP4): the same objects and pass times as an exact scan with the day\'s element sets; the database is not touched', { timeout: 300_000 }, async () => {
  clearPassesCaches(); clearStoreCaches(); poolCalls = 0;
  const from = dayMs(D0), to = dayMs(D1) + DAY_MS;
  let found = 0;
  for (const region of [circleRegion(30, 20, 3000), circleRegion(-17.5, 179.5, 1500), circleRegion(48.85, 2.35, 500)]) {
    const r = await passesOver(fakePool, region, from, to, { ...base, dir: emptyLive, historyDir: tr.root });
    const want = new Map<number, number[]>();
    for (const d of [D0, D1]) for (const [id, iv] of truth(region, d, from, to)) want.set(id, [...(want.get(id) ?? []), ...iv]);
    assert.deepEqual([...r.allIds!].sort((a, b) => a - b), [...want.keys()].sort((a, b) => a - b), region.id);
    for (const o of r.objects) assert.deepEqual(o.passes, mergePieces(want.get(o.noradId)!), `${region.id} ${o.noradId}`);
    assert.deepEqual(r.missingDays, []);
    assert.equal(r.stats.days, 2);
    found += r.totalObjects;
  }
  assert.ok(found >= 10, `passes found: ${found}`);
  assert.equal(poolCalls, 0);
});

test('1965 days (SGP from the manifest): refined with the original SGP model, not SGP4', { timeout: 300_000 }, async () => {
  clearPassesCaches(); clearStoreCaches();
  const from = dayMs('1965-06-05'), to = dayMs('1965-06-07');
  const m = readManifest(historyCoverageDir(tr.root)!, '1965-06-06')!;
  assert.equal(m.propagators!.sgp.length, 12);
  assert.ok(m.accuracy && m.accuracy.medianKm === 79);
  const region = circleRegion(20, 0, 3000);
  const r = await passesOver(fakePool, region, from, to, { ...base, dir: emptyLive, historyDir: tr.root });
  const want = new Map<number, number[]>();
  for (const d of ['1965-06-05', '1965-06-06']) for (const [id, iv] of truth(region, d, from, to)) want.set(id, [...(want.get(id) ?? []), ...iv]);
  assert.ok(want.size >= 4, `${want.size} objects pass a 3000 km circle`);
  assert.deepEqual([...r.allIds!].sort((a, b) => a - b), [...want.keys()].sort((a, b) => a - b));
  for (const o of r.objects) assert.deepEqual(o.passes, mergePieces(want.get(o.noradId)!), String(o.noradId));
  // SGP and SGP4 really differ for these sets (drag in MEAN_MOTION_DOT): the pass times are not those of SGP4
  const sgp4Times = new Map<number, number[]>();
  for (const o of getHistoryStore(tr.root).dayCatalog('1965-06-06')) { const p = makeProp(o.omm); const iv = p ? passesIn(p, region, [dayMs('1965-06-06'), dayMs('1965-06-07')], newStats()) : []; if (iv.length) sgp4Times.set(o.noradId, iv); }
  const same = [...sgp4Times].filter(([id, iv]) => JSON.stringify(iv) === JSON.stringify(truth(region, '1965-06-06', dayMs('1965-06-06'), dayMs('1965-06-07')).get(id))).length;
  assert.ok(same < sgp4Times.size, 'SGP pass times differ from SGP4 ones for the 1965 sets');
});

test('missing days are listed; a window over days without coverage returns nothing but lists them; the 90-day limit stays', { timeout: 120_000 }, async () => {
  clearPassesCaches(); clearStoreCaches();
  const region = circleRegion(30, 20, 3000);
  const r = await passesOver(fakePool, region, dayMs('2026-10-09'), dayMs('2026-10-13'), { ...base, dir: emptyLive, historyDir: tr.root });
  assert.deepEqual(r.missingDays, ['2026-10-09', '2026-10-10']);
  assert.equal(r.stats.days, 2);
  const none = await passesOver(fakePool, region, dayMs('1999-01-01'), dayMs('1999-01-05'), { ...base, dir: emptyLive, historyDir: tr.root });
  assert.equal(none.totalObjects, 0); assert.equal(none.missingDays.length, 4);
  await assert.rejects(passesOver(fakePool, region, dayMs('1998-12-01'), dayMs('1998-12-01') + 91 * DAY_MS, { ...base, dir: emptyLive, historyDir: tr.root }), (e: unknown) => e instanceof PassesError && e.code === 'too-long');
  // no history root: the same window has no data at all
  const off = await passesOver(fakePool, region, dayMs(D0), dayMs(D1) + DAY_MS, { ...base, dir: emptyLive, historyDir: null });
  assert.equal(off.totalObjects, 0); assert.deepEqual(off.missingDays, [D0, D1]);
  const set = await passedOverSet(fakePool, region, dayMs(D0), dayMs(D1) + DAY_MS, { ...base, dir: emptyLive, historyDir: tr.root });
  assert.ok(set.ids.size > 0 && set.missingDays.length === 0);
});

test('the live coverage directory wins over history for a day both have (and then uses the database)', { timeout: 120_000 }, async () => {
  clearPassesCaches(); clearStoreCaches(); poolCalls = 0;
  const live = mkdtempSync(join(tmpdir(), 'live-copy-'));
  try {
    mkdirSync(join(live, D1), { recursive: true });
    cpSync(join(tr.root, 'coverage', D1), join(live, D1), { recursive: true });
    const region = circleRegion(30, 20, 3000);
    // D0 from history (no database), D1 from the live directory (element sets from the database: the fake pool fails it)
    await assert.rejects(passesOver(fakePool, region, dayMs(D0), dayMs(D1) + DAY_MS, { ...base, dir: live, historyDir: tr.root }), /database must not be used/);
    assert.ok(poolCalls > 0);
    // only the history day: fine
    poolCalls = 0; clearPassesCaches();
    const r = await passesOver(fakePool, region, dayMs(D0), dayMs(D1), { ...base, dir: live, historyDir: tr.root });
    assert.equal(r.stats.days, 1); assert.equal(poolCalls, 0);
  } finally { rmSync(live, { recursive: true, force: true }); }
});

test('scanWindow / anyPassIn / firstInside at instants before 1970 (negative ms): passes are found, "none" is not confused with a time', async () => {
  const { scanWindow, firstInside, NO_TIME } = await import('../../src/ssa/coverage/scan.js');
  const flagsAt = (a: number, b: number) => (_p: unknown, t: number) => ({ inside: t >= a && t <= b, near: t >= a - 5000 && t <= b + 5000 });
  const t0 = Date.parse('1965-06-06T00:00:00Z'); // negative
  assert.ok(t0 < 0);
  const out: number[] = [];
  scanWindow({} as never, t0, t0 + 300_000, 20_000, 1000, flagsAt(t0 + 61_000, t0 + 99_000) as never, out);
  assert.deepEqual(out, [t0 + 61_000, t0 + 99_000]);
  assert.equal(firstInside({} as never, t0, t0 + 300_000, 20_000, 1000, flagsAt(t0 + 61_000, t0 + 99_000) as never), t0 + 61_000);
  assert.equal(firstInside({} as never, t0, t0 + 300_000, 20_000, 1000, flagsAt(t0 + 1e9, t0 + 1e9 + 1) as never), NO_TIME);
  // a pass that is open at the very start of a pre-1970 window
  const out2: number[] = [];
  scanWindow({} as never, t0, t0 + 100_000, 20_000, 1000, flagsAt(t0 - 10_000, t0 + 30_000) as never, out2);
  assert.deepEqual(out2, [t0, t0 + 30_000]);
});
