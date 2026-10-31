import test from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';
import { causalSelect, hardBodyRadiusKm, isManoeuvrable, matchEncounters, identicalGroups, SIGMA_FLOOR, floorSigma } from '../../src/ssa/encounter.js';
import { SFS_VOLUMES, shapeFromOmm, volumeIdFor, findMinima, shellCounts } from '../../src/ssa/volumes.js';
import { labelEncounter } from '../../src/ssa/ca-label.js';
import { defaultModel, sigmaRic, classKey, resolveClass } from '../../src/ssa/uncertainty.js';
import { fromEnriched } from '../../src/ssa/catalog.js';
import { SSA_CRON } from '../../src/ssa/nightly.js';
import type { SsaObject } from '../../src/ssa/types.js';

const obj = (id: number, epoch: string, extra: Record<string, unknown> = {}): SsaObject => ({ noradId: id, name: `O${id}`, omm: { EPOCH: epoch, MEAN_MOTION: 15, ECCENTRICITY: 0.001, INCLINATION: 50, ...extra } });

test('causal selection: latest set with epoch <= batch time per object, order of first appearance, future sets ignored', () => {
  const t = Date.parse('2026-10-12T12:00:00Z');
  const cat = [obj(2, '2026-10-12T05:00:00.000Z'), obj(1, '2026-10-11T00:00:00.000Z'), obj(1, '2026-10-12T11:59:59.999Z', { MARK: 1 }), obj(1, '2026-10-12T12:00:00.001Z'), obj(3, '2026-10-12T13:00:00Z'), obj(2, '2026-10-12T12:00:00Z', { MARK: 2 })];
  const r = causalSelect(cat, t);
  assert.deepEqual(r.objs.map((o) => [o.noradId, o.omm.MARK ?? null]), [[2, 2], [1, 1]]); // the set AT the batch time counts; 3 has none yet
  assert.equal(r.noEarlierSet, 1);
  assert.deepEqual(causalSelect([], t), { objs: [], noEarlierSet: 0 });
});

test('screening volume by orbit regime', () => {
  const id = (mm: number, ecc: number, inc: number) => volumeIdFor(shapeFromOmm({ MEAN_MOTION: mm, ECCENTRICITY: ecc, INCLINATION: inc }));
  assert.equal(id(15.5, 0.0007, 51.6), 5); // ISS: perigee < 500 km
  assert.equal(id(15.0, 0.001, 53), 4); // ~550 km
  assert.equal(id(14.0, 0.001, 98), 3); // 750-1,200 km
  assert.equal(id(13.0, 0.001, 98), 2); // 1,200-2,000 km
  assert.equal(id(11.0, 0.001, 85), 7); // above 2,000 km, period < 225 min: other near Earth
  assert.equal(id(1.0027, 0.0002, 0.05), 1); // GEO
  assert.equal(id(2.0, 0.0001, 55), 6); // MEO / GNSS: period > 225 min, near circular
  assert.equal(id(2.0, 0.7, 63), 6); // Molniya-like: ecc >= 0.25, period > 225 min
  assert.equal(id(10, 0.3, 30), 7); // high ecc, short period
  assert.equal(SFS_VOLUMES[4]!.name, 'LEO1');
  assert.deepEqual([SFS_VOLUMES[4]!.u, SFS_VOLUMES[4]!.v, SFS_VOLUMES[4]!.w], [0.4, 44, 51]);
});

test('findMinima polishes a closest approach to the requested tolerance', () => {
  // straight-line flyby: r(t) = (t - 5000, 3), v = (1, 0) per ms-scaled unit; minimum of |r| at t = 5000
  const rel = (t: number) => ({ r: [(t - 5000.123) * 1e-3, 3, 0] as [number, number, number], v: [1e-3, 0, 0] as [number, number, number] });
  const m = findMinima(rel, 0, 20_000, 1000, 0.01);
  assert.equal(m.length, 1);
  assert.ok(Math.abs(m[0]! - 5000.123) < 0.01, `${m[0]}`);
  assert.deepEqual(findMinima((t) => ({ r: [-(t + 1), 0, 0], v: [-1, 0, 0] }), 0, 1000, 100), []); // receding only: no minimum
});

test('shell counts: objects whose radius ranges never meet have no partner', () => {
  const sc = shellCounts(Float64Array.from([6700, 6700, 42000]), Float64Array.from([6800, 6800, 42200]), 10);
  assert.deepEqual([...sc.perObject], [2, 2, 1]);
});

test('matching: same pair within 60 s, nearest first, one to one', () => {
  const prev = [{ a: 1, b: 2, tca: 1000 }, { a: 1, b: 2, tca: 5_400_000 }, { a: 3, b: 4, tca: 2000 }];
  const next = [{ a: 2, b: 1, tca: 5_430_000 }, { a: 1, b: 2, tca: 60_000 }, { a: 3, b: 4, tca: 62_001 }, { a: 5, b: 6, tca: 0 }];
  assert.deepEqual([...matchEncounters(prev, next)], [1, 0, -1, -1]);
  assert.deepEqual([...matchEncounters([{ a: 1, b: 2, tca: 0 }], [{ a: 1, b: 2, tca: 1000 }, { a: 1, b: 2, tca: 2000 }])], [0, -1]);
});

test('hard-body radius, floor, manoeuvrable, identical groups, labels', () => {
  assert.equal(hardBodyRadiusKm({ noradId: 1, name: 'X', objectType: 'unknown', rcsSize: 'LARGE' }), 0.003);
  assert.equal(hardBodyRadiusKm({ noradId: 1, name: 'X', objectType: 'debris', rcsSize: 'SMALL' }), 0.00005);
  assert.equal(hardBodyRadiusKm({ noradId: 1, name: 'X', objectType: 'rocket_body', rcsSize: null }), 0.003);
  assert.equal(hardBodyRadiusKm({ noradId: 25544, name: 'ISS (ZARYA)' }), 0.055);
  assert.equal(hardBodyRadiusKm({ noradId: 48274, name: 'CSS (TIANHE)' }), 0.025);
  assert.deepEqual(floorSigma([0.04, 0.28, 0.04]), SIGMA_FLOOR);
  assert.equal(isManoeuvrable({ name: 'STARLINK-1234', objectType: 'unknown' }), true);
  assert.equal(isManoeuvrable({ name: 'STARLINK-1234 DEB', objectType: 'debris' }), false);
  const a = obj(1, '2026-10-12T00:00:00Z'), b = obj(2, '2026-10-12T00:00:00Z'), c = obj(3, '2026-10-12T00:00:01Z');
  const g = identicalGroups([a, b, c]);
  assert.deepEqual([...g.group], [0, 0, -1]);
  const e = (name: string, id: string, raan: number, mm = 15) => ({ name, objectId: id, meanMotion: mm, incDeg: 53, raanDeg: raan });
  assert.equal(labelEncounter(e('A 1', '2020-001A', 10), e('B 2', '2021-002B', 10), 5), 'twin');
  assert.equal(labelEncounter(e('A 1', '2020-001A', 10), e('B 2', '2021-002B', 50), 0.2), 'co_moving');
  assert.equal(labelEncounter(e('A 1', '2020-001A', 10), e('B 2', '2020-001B', 50), 5), 'same_launch');
  assert.equal(labelEncounter(e('STARLINK-1', '2020-001A', 10), e('STARLINK-2', '2021-002B', 50), 5), 'same_family');
  assert.equal(labelEncounter(e('A 1', '2020-001A', 10), e('B 2', '2021-002B', 50), 5), 'crossing');
});

test('uncertainty model: embedded class table, growth with age, tail factor', () => {
  const m = defaultModel();
  assert.ok(m.classes.ALL && Object.keys(m.classes).length > 30);
  assert.equal(classKey('LEO', 'debris', 520, 3e-4), 'LEO/debris/p400-600/b1');
  assert.equal(resolveClass(m, 'GEO/not-a-type'), m.classes['GEO'] ? 'GEO' : 'ALL');
  const s1 = sigmaRic('LEO/unknown/p400-600', 1), s5 = sigmaRic('LEO/unknown/p400-600', 5);
  for (let k = 0; k < 3; k++) assert.ok(s5[k]! > s1[k]!, 'error grows with age');
  assert.deepEqual(sigmaRic('LEO/unknown/p400-600', 0.01), sigmaRic('LEO/unknown/p400-600', 0.25)); // flat below the shortest measured gap
  assert.deepEqual(sigmaRic('LEO/unknown/p400-600', -2), sigmaRic('LEO/unknown/p400-600', 2)); // the sign of the age is dropped
});

test('catalog mapping and schedule', () => {
  const o = fromEnriched({ noradId: 7, name: 'X', omm: { EPOCH: 'e' }, objectType: 'satellite', category: 'active_satellite', regime: 'LEO', perigee: 500, rcsSize: 'SMALL' });
  assert.deepEqual([o.objectType, o.regime, o.perigee, o.rcsSize], ['unknown', 'LEO', 500, 'SMALL']);
  assert.equal(fromEnriched({ noradId: 7, name: 'X', omm: {}, objectType: 'debris' }).objectType, 'debris');
  assert.equal(SSA_CRON, '30 2 * * *');
  assert.ok(cron.validate(SSA_CRON));
});
