// deriveChanges / deriveFormations on small synthetic catalogs (no data files, no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveChanges } from '../../src/ssa/events/changes.js';
import { deriveFormations } from '../../src/ssa/events/formation.js';
import type { ChangeObject } from '../../src/ssa/events/types.js';

const DAY = '2026-10-12';
const T0 = Date.parse(DAY + 'T00:00:00Z');
const H = 3_600_000, D = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const obj = (id: number, over: Record<string, unknown> = {}, extra: Partial<ChangeObject> = {}): ChangeObject => ({
  noradId: id, name: `OBJ-${id}`, regime: 'LEO', perigee: 560, apogee: 562,
  omm: {
    OBJECT_NAME: `OBJ-${id}`, EPOCH: iso(T0 - 6 * H), MEAN_MOTION: 15.1, ECCENTRICITY: 0.0001, INCLINATION: 53, RA_OF_ASC_NODE: 10,
    ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0, BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: id, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1000, ...over,
  },
  ...extra,
});
const kind = (rows: ReturnType<typeof deriveChanges>['rows'], k: string) => rows.filter((r) => r.kind === k);

test('object.appeared: new_launch / returned / newly_cataloged', () => {
  const prev = [obj(1)];
  const cur = [
    obj(1),
    obj(2, {}, { launchDate: '2026-10-01' }), // launched 11 days before the day
    obj(3), // seen in an earlier catalog
    obj(4), // never seen
    obj(5, {}, { launchDate: '2026-08-01' }),
  ];
  const { rows, stats } = deriveChanges(prev, cur, T0, { firstSeen: (id) => (id === 3 ? '2026-09-01' : id === 5 ? DAY : undefined) });
  const app = kind(rows, 'object.appeared');
  assert.deepEqual(app.map((r) => [r.subjects[0], r.payload.cls]), [[2, 'new_launch'], [3, 'returned'], [4, 'newly_cataloged'], [5, 'newly_cataloged']]);
  assert.equal(app[0]!.tStart, Date.parse(cur[1]!.omm.EPOCH as string));
  assert.deepEqual(stats.appClass, { new_launch: 1, returned: 1, newly_cataloged: 2 });
  assert.deepEqual(Object.keys(app[0]!.payload).sort(), ['apogee', 'cls', 'launch', 'name', 'perigee', 'reg']);
});

test('object.disappeared: decay_likely / ambiguous_low / stale_window / unexplained, and no GCAT or live-catalog fields', () => {
  const old = (id: number, ageD: number, perigee: number, over: Record<string, unknown> = {}) => obj(id, { EPOCH: iso(T0 - ageD * D), ...over }, { perigee });
  const prev = [
    old(1, 5, 120), // low perigee: decay signature, whatever its age
    old(2, 5, 500), // fresh set, normal orbit
    old(3, 29, 500), // old set
    old(4, 29, 300), // old set, lowish perigee
    old(5, 5, 500, { MEAN_MOTION: 17.5 }), // propagates below 140 km at the day start
    obj(9),
  ];
  const { rows } = deriveChanges(prev, [obj(9)], T0);
  const by = new Map(kind(rows, 'object.disappeared').map((r) => [r.subjects[0]!, r]));
  assert.deepEqual([...by.keys()].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => by.get(i)!.payload.cls), ['decay_likely', 'unexplained', 'stale_window', 'ambiguous_low', 'decay_likely']);
  const p = by.get(2)!.payload;
  assert.equal(by.get(2)!.tStart, T0);
  assert.equal(p.ageDays, 5);
  assert.equal(p.lastEpoch, iso(T0 - 5 * D));
  assert.ok(typeof p.altKm === 'number' && p.altKm > 400 && p.altKm < 700);
  for (const k of ['cls', 'reg', 'ageDays', 'perigee', 'apogee', 'bstar', 'mmdot', 'altKm', 'lastEpoch', 'name']) assert.ok(k in p, k);
  assert.ok(!('satcat' in p) && !('live' in p));
});

test('elements.jump: thresholds on position error, semi-major axis change and drag-corrected change', () => {
  const t1 = T0 + 2 * H; // epoch of the new sets
  const prev = [obj(1), obj(2), obj(3), obj(4), obj(5, { MEAN_MOTION_DOT: 0 })];
  const cur = [
    obj(1, { EPOCH: iso(t1), MEAN_MOTION: 15.12 }), // orbit lowered: large position error and da
    obj(2, { EPOCH: iso(t1), MEAN_MOTION: 15.08 }), // raised
    obj(3, { EPOCH: iso(t1) }), // new epoch, same orbit: small error
    obj(4), // unchanged epoch: not a change at all
    obj(5, { EPOCH: iso(t1), MEAN_ANOMALY: 0.002 }), // tiny shift: below 16.3 km
  ];
  const { rows, stats } = deriveChanges(prev, cur, T0);
  const j = kind(rows, 'elements.jump');
  assert.deepEqual(j.map((r) => [r.subjects[0], r.payload.dir]), [[1, 'lower'], [2, 'raise']]);
  // the times come from the satrec's Julian date: equal to the epoch to within a few hundredths of a millisecond
  assert.ok(Math.abs(j[0]!.tEnd - t1) < 1 && Math.abs(j[0]!.tStart - (T0 - 6 * H)) < 1);
  for (const k of ['dpos', 'da', 'resid', 'dinc', 'along', 'gap', 'dir', 'reg', 'name']) assert.ok(k in j[0]!.payload, k);
  assert.ok((j[0]!.payload.da as number) < -1 && (j[1]!.payload.da as number) > 1);
  assert.equal(stats.changedElsets, 4);
  assert.deepEqual(stats.jumpDir, { lower: 1, raise: 1 });
});

test('close.formation: a pair within 50 km all day is one; a distant pair, a lone object and an identical-set pair are not', () => {
  const at = (id: number, ma: number, over: Record<string, unknown> = {}) => obj(id, { EPOCH: iso(T0), MEAN_ANOMALY: ma, ...over });
  const cur = [
    at(10, 0), at(11, 0.1), // 0.1 deg of arc is about 12 km
    at(20, 90), at(21, 95), // 5 deg is about 600 km
    at(30, 180), at(31, 180), // identical element sets (the ISS stack case): excluded
    at(40, 270, { MEAN_MOTION: 6.0 }), // alone, high
  ];
  const { rows, stats } = deriveFormations(cur, T0);
  assert.deepEqual(rows.map((r) => r.subjects), [[10, 11]]);
  const r = rows[0]!;
  assert.equal(r.kind, 'close.formation');
  assert.equal(r.tStart, T0);
  assert.equal(r.tEnd, T0 + D);
  assert.equal(r.payload.frac, 1);
  assert.ok((r.payload.minKm as number) > 5 && (r.payload.minKm as number) < 20, String(r.payload.minKm));
  assert.equal(stats.objects, 7);
  assert.equal(stats.pairs, 1);
});
