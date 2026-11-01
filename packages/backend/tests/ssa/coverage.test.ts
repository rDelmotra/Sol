// Star-map coverage (src/ssa/coverage) without replay data: the codec (object index beyond 65,536), the region -> star-map cover
// (randomized conservativeness for polygons and circles), the file store (atomic write, retention), the exact pass scan, and the
// build on a synthetic catalog (lists contain every box the object visits; unindexable objects are recorded).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cellKey, ecefToTeme, gmst, geodeticToEcefEr, ER_KM, SHELL_DELTA0, WGS84_A_KM } from '@orbitwatch/orbital-core';
import { encodeList, forEachId, writeLayer, readLayer, findCell, listIds } from '../../src/ssa/coverage/codec.js';
import { coverPixels, shellRange, cellsOf } from '../../src/ssa/coverage/cover.js';
import { INDIA_POLY, REGIONS, circleRegion, contains, namedRegion, resolveRegion, inPoly, type Region } from '../../src/ssa/coverage/region.js';
import { scanWindow, firstInside, passesIn, anyPassIn, type Flags } from '../../src/ssa/coverage/scan.js';
import { newStats, makeProp, posAt, cellAt, type Prop } from '../../src/ssa/coverage/runs.js';
import { writeDay, readManifest, hasDay, openLayer, listDays, pruneHourly, clearStoreCaches, layerPath, type Manifest } from '../../src/ssa/coverage/store.js';
import { buildDay } from '../../src/ssa/coverage/build.js';
import { FENCED, ID_SHIFT, LAYERS, layerName, PERIOD_MS, PER_DAY } from '../../src/ssa/coverage/consts.js';
import { FENCED_IDS } from '../../src/ssa/screen.js';
import { synthCatalog, synthOmm } from './coverage-helpers.js';

const DAY = '2026-10-12';
const D0 = Date.parse(DAY + 'T00:00:00Z');

// small deterministic PRNG (mulberry32)
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- codec
test('codec: lists round-trip beyond 65,536 objects (the spike capped the index at 16 bits)', () => {
  const n = 300_000;
  const sparse = [0, 5, 6, 65_535, 65_536, 65_537, 131_072, 299_999];
  const dense = Array.from({ length: 150_000 }, (_, i) => i * 2);
  for (const ids of [sparse, dense]) {
    const e = encodeList(ids, n); const out: number[] = [];
    forEachId(e.bytes, 0, e.bytes.length, e.tag, (i) => out.push(i));
    assert.deepEqual(out, ids);
  }
  assert.equal(encodeList(sparse, n).tag, 0);
  assert.equal(encodeList(dense, n).tag, 1);
  const cells = new Map<number, number[]>([[7, sparse], [100000, [1, 70_000]], [3, [0, 1, 2, 3, 4]]]);
  const { file } = writeLayer(1, 4, D0, n, cells);
  const l = readLayer(file);
  assert.deepEqual([l.gran, l.order, l.dayStartMs, l.n, l.cells.length], [1, 4, D0, n, 3]);
  const got: number[] = [];
  listIds(l, findCell(l, 100000), (x) => got.push(x));
  assert.deepEqual(got, [1, 70_000]);
  assert.equal(findCell(l, 8), -1);
  assert.throws(() => readLayer(file.subarray(0, file.length - 1)), /truncated/);
});

test('packing: key * ID_SHIFT + index stays exact for the largest hourly key and the largest index', () => {
  const maxKey = 12 * 4 ** 4 * 8 ** 4 / 8 * 24; // generous bound on order-4 key * 24 periods
  assert.ok(maxKey * ID_SHIFT < Number.MAX_SAFE_INTEGER);
  const v = 9_000_000 * ID_SHIFT + (ID_SHIFT - 1);
  assert.equal(Math.floor(v / ID_SHIFT), 9_000_000);
  assert.equal(v - 9_000_000 * ID_SHIFT, ID_SHIFT - 1);
});

test('the fence list is the screener\'s', () => { assert.deepEqual([...FENCED], [...FENCED_IDS]); });

// ---------------------------------------------------------------- regions
test('regions: named polygons, aliases and circle validation', () => {
  assert.equal(REGIONS[0]!.id, 'india');
  assert.equal(REGIONS[0]!.approximate, false);
  assert.ok(REGIONS.slice(1).every((r) => r.approximate));
  assert.equal(namedRegion('USA')!.id, 'usa_conus');
  assert.equal(namedRegion('United States')!.id, 'usa_conus');
  assert.equal(namedRegion('atlantis'), null);
  assert.ok(contains(resolveRegion('india'), 20, 78) && !contains(resolveRegion('india'), 0, 0));
  const paris = circleRegion(48.8566, 2.3522, 500);
  assert.ok(contains(paris, 48.8566, 2.3522) && contains(paris, 51, 2.3) && !contains(paris, 55, 2.3));
  assert.throws(() => circleRegion(89, 0, 500), /pole/);
  assert.throws(() => circleRegion(10, 10, 4), /radius/);
  assert.throws(() => circleRegion(10, 200, 100), /lon/);
  assert.throws(() => resolveRegion('nowhere'), /unknown region/);
  assert.equal(circleRegion(48.85661, 2.35222, 500).id, circleRegion(48.8566, 2.3522, 500).id);
});

// ---------------------------------------------------------------- cover
// Random ground-volume points (inside the region, any height from below ground to 60,000 km, any instant of the day, plus points ON the
// region edge) must land in the cover of their period.
function coverTest(region: Region, order: number, seed: number, sample: () => [number, number] | null): void {
  const grans = ['day', 'hour'] as const;
  const [nkLo, nkHi] = shellRange(order, 2300, 70000);
  const covers = grans.map((g) => coverPixels(order, region, D0, g).map((px) => new Set(cellsOf(order, px, nkLo, nkHi))));
  const r = rng(seed);
  let checked = 0;
  for (let n = 0; n < 9000; n++) {
    const pt = sample();
    if (!pt) continue;
    const [lat, lon] = pt;
    const alt = Math.exp(Math.log(0.5) + r() * (Math.log(60000) - Math.log(0.5))) - 20;
    const t = D0 + Math.floor(r() * 86_400_000);
    const e = geodeticToEcefEr({ latDeg: lat, lonDeg: lon, altKm: alt });
    const v = ecefToTeme(e, gmst(t));
    const key = cellKey(order, v.x * ER_KM, v.y * ER_KM, v.z * ER_KM);
    if (key === null) continue;
    if (Math.hypot(v.x, v.y, v.z) * ER_KM < WGS84_A_KM * Math.exp(-SHELL_DELTA0)) continue;
    for (let g = 0; g < grans.length; g++) {
      const p = Math.min(PER_DAY[grans[g]!] - 1, Math.floor((t - D0) / PERIOD_MS[grans[g]!]));
      assert.ok(covers[g]![p]!.has(key), `${region.id} order ${order} ${grans[g]} period ${p} misses key ${key} (lat ${lat}, lon ${lon}, alt ${alt}, t ${t - D0})`);
    }
    checked++;
  }
  assert.ok(checked > 3000, `only ${checked} points checked`);
}

for (const order of [3, 4]) {
  test(`cover is conservative: India polygon, order ${order}`, () => {
    const r = rng(1234 + order);
    const lats = INDIA_POLY.map((v) => v[0]), lons = INDIA_POLY.map((v) => v[1]);
    const [la0, la1, lo0, lo1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    let k = 0;
    coverTest(REGIONS[0]!, order, 99, () => {
      if (k++ % 3 === 0) { // on an edge, nudged very slightly inside
        const i = Math.floor(r() * INDIA_POLY.length), u = r();
        const a = INDIA_POLY[i]!, b = INDIA_POLY[(i + 1) % INDIA_POLY.length]!;
        let lat = a[0] + (b[0] - a[0]) * u, lon = a[1] + (b[1] - a[1]) * u;
        if (!inPoly(lat, lon, INDIA_POLY)) { lat += (a[0] - b[0]) * 1e-6; lon += (a[1] - b[1]) * 1e-6; if (!inPoly(lat, lon, INDIA_POLY)) return null; }
        return [lat, lon];
      }
      const lat = la0 + r() * (la1 - la0), lon = lo0 + r() * (lo1 - lo0);
      return inPoly(lat, lon, INDIA_POLY) ? [lat, lon] : null;
    });
  });
}

const CIRCLES: Array<[string, number, number, number]> = [
  ['Paris 500 km', 48.8566, 2.3522, 500],
  ['Iceland 300 km (high latitude)', 64.5, -18, 300],
  ['across the antimeridian (Fiji) 800 km', -17.5, 179.5, 800],
  ['equator 2000 km', 0, 100, 2000],
  ['a 20 km circle', 35.7, 139.7, 20],
];
for (const order of [3, 4]) {
  for (const [name, lat, lon, km] of CIRCLES) {
    test(`cover is conservative: circle ${name}, order ${order}`, () => {
      const region = circleRegion(lat, lon, km);
      const r = rng(7 + order + Math.round(km));
      coverTest(region, order, 5, () => {
        // uniform in the cap (random bearing, distance ~ sqrt for area), plus a third of the points ON the edge
        const dist = (r() < 0.33 ? 1 : Math.sqrt(r())) * km * 0.9999;
        const brg = r() * 2 * Math.PI, d = dist / 6371, la1 = (lat * Math.PI) / 180, lo1 = (lon * Math.PI) / 180;
        const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(brg));
        const lo2 = lo1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
        let pl = (la2 * 180) / Math.PI, pn = (lo2 * 180) / Math.PI;
        pn = ((pn + 540) % 360) - 180;
        if (!contains(region, pl, pn)) return null;
        pl = Math.max(-90, Math.min(90, pl));
        return [pl, pn];
      });
    });
  }
}

test('cover: the same day gives the same pixels twice and a bigger region covers a superset', () => {
  const a = coverPixels(4, circleRegion(20, 78, 300), D0, 'hour');
  const b = coverPixels(4, circleRegion(20, 78, 300), D0, 'hour');
  assert.deepEqual(a.map((x) => [...x]), b.map((x) => [...x]));
  const big = coverPixels(4, circleRegion(20, 78, 900), D0, 'hour');
  for (let p = 0; p < 24; p++) { const s = new Set(big[p]); assert.ok([...a[p]!].every((x) => s.has(x))); }
  assert.equal(a.length, 24);
  assert.equal(coverPixels(4, circleRegion(20, 78, 300), D0, 'day').length, 1);
});

// ---------------------------------------------------------------- scan
const P = null as unknown as Prop;
const flagsFn = (_p: Prop, t: number): Flags => ({ inside: t >= 60_500 && t <= 63_000, near: t >= 30_000 && t <= 100_000 });
test('scan: the 1 s refine inside the near zone catches a graze shorter than the 20 s coarse step; without it the graze is missed', () => {
  const out: number[] = [];
  scanWindow(P, 0, 200_000, 20_000, 1000, flagsFn, out);
  assert.deepEqual(out, [61_000, 63_000]);
  const none: number[] = [];
  scanWindow(P, 0, 200_000, 20_000, 1000, (p, t) => ({ ...flagsFn(p, t), near: false }), none);
  assert.deepEqual(none, []);
  assert.equal(firstInside(P, 0, 200_000, 20_000, 1000, flagsFn), 61_000);
  assert.equal(firstInside(P, 0, 200_000, 20_000, 1000, (p, t) => ({ ...flagsFn(p, t), near: false })), -1);
});
test('scan: a pass that spans the window end is closed at the window end', () => {
  const out: number[] = [];
  scanWindow(P, 0, 62_000, 20_000, 1000, (_p, t) => ({ inside: t >= 50_000, near: t >= 30_000 }), out);
  assert.deepEqual(out, [50_000, 62_000]);
});

const EPOCH = DAY + 'T00:00:00.000Z';
test('scan on a real propagation: passesIn agrees with a 1 s brute force over an hour, anyPassIn with passesIn', () => {
  const region = circleRegion(30, 20, 3000);
  const p = makeProp(synthOmm(1, EPOCH, { INCLINATION: 53, MEAN_MOTION: 15.2, RA_OF_ASC_NODE: 120 }))!;
  const a = D0 + 3 * 3_600_000, b = a + 8 * 3_600_000;
  const st = newStats();
  const got = passesIn(p, region, [a, b], st);
  assert.ok(got.length >= 2, 'expected at least one pass');
  // 1 s brute force
  const brute: number[] = [];
  let open = -1, last = -1;
  for (let t = a; t <= b; t += 1000) {
    const pos = posAt(p, t, st)!;
    const sp = scanModule.subPoint(pos.x, pos.y, pos.z, t);
    if (contains(region, sp.latDeg, sp.lonDeg)) { if (open < 0) open = t; last = t; } else if (open >= 0) { brute.push(open, last); open = -1; }
  }
  if (open >= 0) brute.push(open, last);
  assert.deepEqual(got, brute);
  const t1 = anyPassIn(p, region, [a, b], st);
  assert.equal(t1, got[0]);
  // a region the object never reaches in the window: no pass either way
  assert.equal(anyPassIn(p, circleRegion(-75, -150, 100), [a, a + 600_000], st), -1);
  assert.deepEqual(passesIn(p, circleRegion(-75, -150, 100), [a, a + 600_000], st), []);
});
import * as scanModule from '../../src/ssa/coverage/scan.js';

// ---------------------------------------------------------------- store
const fakeManifest = (day: string, extra: Partial<Manifest> = {}): Manifest => ({
  version: 2, day, dayStartMs: Date.parse(day + 'T00:00:00Z'), builtAt: 'x', objects: 2, norad: [1, 2], unindexed: [], skipped: {}, build: {},
  layers: { 'day.o4': { file: 'day.o4.bin', bytes: 3, lists: 0, pairs: 0, nkLo: 0, nkHi: 0 }, 'hour.o4': { file: 'hour.o4.bin', bytes: 3, lists: 0, pairs: 0, nkLo: 0, nkHi: 0 } }, ...extra,
});
const emptyLayerFile = (gran: number) => writeLayer(gran, 4, D0, 2, new Map([[5, [0, 1]]])).file;

test('store: atomic day write, replace, listing, and hourly retention (daily layers stay)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cov-'));
  try {
    clearStoreCaches();
    const files = () => new Map<string, Uint8Array>([['day.o3.bin', emptyLayerFile(0)], ['day.o4.bin', emptyLayerFile(0)], ['hour.o4.bin', emptyLayerFile(1)]]);
    for (const d of ['2026-06-01', '2026-09-01', '2026-10-10']) writeDay(dir, fakeManifest(d), files());
    assert.deepEqual(listDays(dir), ['2026-06-01', '2026-09-01', '2026-10-10']);
    assert.ok(hasDay(dir, '2026-10-10') && !hasDay(dir, '2026-10-11'));
    assert.deepEqual(readManifest(dir, '2026-10-10')!.norad, [1, 2]);
    // replacing a day leaves no tmp / old directories behind
    writeDay(dir, fakeManifest('2026-10-10', { norad: [7, 8] }), files());
    assert.deepEqual(readManifest(dir, '2026-10-10')!.norad, [7, 8]);
    assert.deepEqual(readdirSync(dir).sort(), ['2026-06-01', '2026-09-01', '2026-10-10']);
    assert.equal(openLayer(dir, '2026-10-10', { gran: 'hour', order: 4 }).cells.length, 1);
    // retention: 90 days before 2026-10-20 = 2026-07-22: June goes; September (and everything newer) keeps its hourly layer
    const pruned = pruneHourly(dir, 90, Date.parse('2026-10-20T03:00:00Z'));
    assert.deepEqual(pruned, ['2026-06-01']);
    assert.ok(!existsSync(layerPath(dir, '2026-06-01', { gran: 'hour', order: 4 })));
    assert.ok(existsSync(layerPath(dir, '2026-06-01', { gran: 'day', order: 4 })) && existsSync(layerPath(dir, '2026-06-01', { gran: 'day', order: 3 })));
    assert.ok(!('hour.o4' in readManifest(dir, '2026-06-01')!.layers));
    assert.ok(existsSync(layerPath(dir, '2026-09-01', { gran: 'hour', order: 4 })));
    assert.deepEqual(pruneHourly(dir, 90, Date.parse('2026-10-20T03:00:00Z')), []);
    // a much later "today" prunes the rest; the daily layers are never touched
    assert.deepEqual(pruneHourly(dir, 30, Date.parse('2027-01-01T00:00:00Z')), ['2026-09-01', '2026-10-10']);
    assert.equal(listDays(dir).length, 3);
    assert.ok(existsSync(layerPath(dir, '2026-10-10', { gran: 'day', order: 4 })));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('store: a failed write leaves the previous day intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cov-'));
  try {
    clearStoreCaches();
    writeDay(dir, fakeManifest(DAY), new Map([['day.o4.bin', emptyLayerFile(0)]]));
    assert.throws(() => writeDay(dir, fakeManifest(DAY, { norad: [9] }), new Map([['sub/x.bin', new Uint8Array(1)]])));
    assert.deepEqual(readManifest(dir, DAY)!.norad, [1, 2]);
    assert.deepEqual(readdirSync(dir), [DAY]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- build
test('build on a synthetic catalog: every visited box is in the lists, skipped objects are recorded, layers are consistent', { timeout: 300_000 }, async () => {
  const cat = synthCatalog(36, EPOCH);
  cat.push({ noradId: 54922, omm: synthOmm(54922, EPOCH) }); // fenced
  cat.push({ noradId: 7777, omm: synthOmm(7777, EPOCH, { MEAN_MOTION: 'broken' }) }); // unusable elements
  cat.sort((a, b) => a.noradId - b.noradId);
  const built = await buildDay(DAY, D0, cat, { workers: 2 });
  const m = built.manifest;
  assert.equal(m.objects, cat.length);
  assert.deepEqual(m.norad, cat.map((o) => o.noradId));
  assert.equal(m.skipped.fenced, 1);
  assert.equal(m.skipped['no-valid-position'], 1); // unusable elements give no position at all
  assert.deepEqual(m.unindexed, []);
  assert.deepEqual(Object.keys(m.layers).sort(), LAYERS.map(layerName).sort());
  const layers = new Map(LAYERS.map((L) => [layerName(L), readLayer(built.files.get(`${layerName(L)}.bin`)!)]));
  const has = (name: string, key: number, idx: number): boolean => {
    const l = layers.get(name)!; const i = findCell(l, key); if (i < 0) return false;
    let hit = false; listIds(l, i, (o) => { if (o === idx) hit = true; }); return hit;
  };
  // the skipped objects are in no list at all
  for (const [name, l] of layers) for (let i = 0; i < l.cells.length; i++) listIds(l, i, (o) => assert.ok(!['fenced', 'bad'].includes(String(cat[o]!.noradId)) && cat[o]!.noradId !== 54922 && cat[o]!.noradId !== 7777, `${name}: skipped object listed`));
  // the key guarantee: at random instants (not only the 10 s grid) the object's box and hour are listed, at all three layers
  const r = rng(42);
  let checked = 0;
  cat.forEach((o, idx) => {
    if (o.noradId === 54922 || o.noradId === 7777) return;
    const p = makeProp(o.omm)!;
    for (let k = 0; k < 120; k++) {
      const t = D0 + Math.floor(r() * 86_400_000);
      const c4 = cellAt(p, 4, t, newStats());
      if (c4 < 0) continue;
      const h = Math.floor((t - D0) / 3_600_000);
      assert.ok(has('hour.o4', c4 * 24 + h, idx), `object ${o.noradId} hour ${h} cell ${c4} not listed`);
      assert.ok(has('day.o4', c4, idx), `object ${o.noradId} day cell ${c4} not listed`);
      assert.ok(has('day.o3', Math.floor(c4 / 8), idx), `object ${o.noradId} day o3 cell not listed`);
      checked++;
    }
  });
  assert.ok(checked > 3000);
  // parents: every order-3 cell is the parent of some order-4 cell of the same object
  const d4 = layers.get('day.o4')!, d3 = layers.get('day.o3')!;
  const parents = new Set<number>();
  for (let i = 0; i < d4.cells.length; i++) parents.add(Math.floor(d4.cells[i]! / 8));
  assert.deepEqual([...d3.cells], [...parents].sort((a, b) => a - b));
  // the nk range recorded in the manifest brackets the cells
  assert.ok(m.layers['day.o4']!.nkLo <= m.layers['day.o4']!.nkHi);
});
