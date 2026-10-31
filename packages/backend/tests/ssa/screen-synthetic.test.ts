// The screener on a tiny synthetic catalog (no replay data needed): two satellites in crossing planes that meet at the node line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenEncounters } from '../../src/ssa/screen.js';
import type { SsaObject } from '../../src/ssa/types.js';

const EPOCH = '2026-10-12T11:00:00.000Z';
const sat = (id: number, name: string, inc: number, extra: Record<string, unknown> = {}): SsaObject => ({
  noradId: id, name, objectType: 'unknown', rcsSize: 'MEDIUM', regime: 'LEO', perigee: 560,
  omm: {
    OBJECT_NAME: name, OBJECT_ID: `2020-0${id}A`, EPOCH, MEAN_MOTION: 15.1, ECCENTRICITY: 0.0001, INCLINATION: inc, RA_OF_ASC_NODE: 10,
    ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0, BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: id, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1000, ...extra,
  },
});

test('two objects crossing at a node are found as one encounter with finite Pc; far objects and future sets are left out', { timeout: 120_000 }, async () => {
  const t = Date.parse('2026-10-12T12:00:00Z');
  const cat = [
    sat(10, 'ALPHA', 53),
    sat(11, 'BRAVO', 98, { MEAN_ANOMALY: 0.46 }),
    sat(12, 'CHARLIE', 53, { MEAN_ANOMALY: 180, MEAN_MOTION: 2.0057 }), // semi-synchronous orbit, far from both: no partner
    sat(10, 'ALPHA', 53, { EPOCH: '2026-10-12T13:00:00.000Z' }), // a set from the batch's future: ignored
  ];
  const { encounters, stats } = await screenEncounters(cat, t, { hours: 3, workers: 2 });
  assert.equal(stats.objectsScreened, 3);
  assert.equal(stats.objectsIn, 4);
  assert.ok(encounters.length >= 1, 'expected at least one encounter');
  for (const e of encounters) {
    assert.deepEqual([e.noradA, e.noradB], [10, 11]);
    assert.ok(e.missKm < 50 && e.vrelKms > 5);
    assert.ok(e.tcaMs >= t && e.tcaMs <= t + 3 * 3_600_000);
    assert.ok(Number.isFinite(e.pc) && e.pc >= 0 && e.pc <= 1 && e.pcMax >= e.pc);
    assert.ok(e.hbrKm === 0.002 && e.label === 'crossing' && e.manoeuvrable === false);
  }
  const best = encounters.reduce((m, e) => (e.missKm < m.missKm ? e : m));
  assert.ok(best.missKm < 5, `closest encounter ${best.missKm} km`);
  assert.equal(stats.elementCutoffMs, Date.parse(EPOCH));
});

test('an empty or one-object catalog screens to nothing', async () => {
  const t = Date.parse('2026-10-12T12:00:00Z');
  assert.deepEqual((await screenEncounters([], t)).encounters, []);
  assert.deepEqual((await screenEncounters([sat(1, 'A', 53)], t)).encounters, []);
});
