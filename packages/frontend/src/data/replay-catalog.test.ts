import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  buildReplayResult,
  clampDay,
  fragmentIds,
  launchOfDesignator,
  normalizeObjectType,
  normalizeOmm,
  stableOrder,
  toEnrichedObject,
} from './replay-catalog';
import type { HistoryCatalogObject, HistoryCatalogResponse } from './replay-types';
import { histObj } from './replay-fixtures';

const resp = (objects: HistoryCatalogObject[], day = '1998-11-20'): HistoryCatalogResponse => ({
  day,
  accuracy: { medianKm: 3.2, p95Km: 20 },
  objects,
});

describe('replay catalog shaping', () => {
  it('maps a catalog object to the EnrichedTLEObject the renderer reads', () => {
    const e = toEnrichedObject(histObj(25544));
    assert.equal(e.noradId, 25544);
    assert.equal(e.objectType, 'satellite');
    assert.equal(e.regime, 'LEO');
    assert.ok(Math.abs(e.period - 1440 / 15.6) < 1e-9);
    assert.ok(e.perigee > 300 && e.perigee < 450, `perigee ${e.perigee}`);
    assert.equal(e.launchTag, '1998-067');
    assert.equal(e.status, 'in_orbit');
    assert.equal(e.epoch, '1998-11-20T12:00:00.000Z');
    // numeric strings become numbers; EPOCH stays zoneless for the WASM parser
    assert.equal(e.omm.MEAN_MOTION, 15.6);
    assert.equal(e.omm.EPOCH, '1998-11-20T12:00:00.000');
  });

  it('normalizes object types (SATCAT spelling, name fallback)', () => {
    assert.equal(normalizeObjectType('ROCKET BODY'), 'rocket_body');
    assert.equal(normalizeObjectType('DEBRIS'), 'debris');
    assert.equal(normalizeObjectType('satellite'), 'satellite');
    assert.equal(normalizeObjectType(null, 'SL-4 R/B'), 'rocket_body');
    assert.equal(normalizeObjectType('', 'COSMOS 2251 DEB'), 'debris');
    assert.equal(normalizeObjectType('TBA'), 'unknown');
  });

  it('strips a trailing Z from EPOCH and fills missing numbers with 0', () => {
    const o = histObj(1).omm;
    const n = normalizeOmm({ ...o, EPOCH: '1965-06-05T01:02:03Z', MEAN_MOTION_DDOT: 'x' as unknown as number });
    assert.equal(n.EPOCH, '1965-06-05T01:02:03');
    assert.equal(n.MEAN_MOTION_DDOT, 0);
  });

  it('launch designators', () => {
    assert.equal(launchOfDesignator('1993-036PX'), '1993-036');
    assert.equal(launchOfDesignator('1958 ALPHA'), null);
    assert.equal(launchOfDesignator(null), null);
  });

  it('carries the SGP propagator flag on the TLE inputs and counts it', () => {
    const r = buildReplayResult(resp([histObj(1), histObj(2, { propagator: 'sgp' }), histObj(3, { propagator: 'sgp' })]));
    assert.equal(r.sgpCount, 2);
    assert.deepEqual(r.result.tles.map((t) => t.propagator ?? 'sgp4'), ['sgp4', 'sgp', 'sgp']);
    assert.deepEqual(r.accuracy, { medianKm: 3.2, p95Km: 20 });
    assert.equal(r.result.catalogData.length, 3);
  });
});

describe('stableOrder — catalog → renderer swap keeps identity by noradId', () => {
  const ids = (xs: { noradId: number }[]) => xs.map((x) => x.noradId);
  const o = (n: number) => ({ noradId: n });

  it('survivors keep their slot; a decayed slot is reused by a new launch; extra launches append', () => {
    const prev = [o(10), o(20), o(30), o(40)];
    const next = [o(10), o(30), o(40), o(50), o(60)]; // 20 decayed, 50 + 60 launched
    const out = stableOrder(prev, next);
    assert.deepEqual(ids(out), [10, 50, 30, 40, 60]);
  });

  it('a shrinking catalog moves only the survivors past the new length', () => {
    const prev = [o(1), o(2), o(3), o(4), o(5)];
    const next = [o(1), o(3), o(5)]; // 2 and 4 gone
    const out = stableOrder(prev, next);
    assert.equal(out[0].noradId, 1);
    assert.equal(out[2].noradId, 3);
    assert.deepEqual(new Set(ids(out)), new Set([1, 3, 5]));
    assert.equal(out.length, 3);
  });

  it('is a permutation of next (no loss, no duplicates) for random sets', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 50; k++) {
      const prev = [...new Set(Array.from({ length: 40 }, () => Math.floor(rnd() * 80)))].map(o);
      const next = [...new Set(Array.from({ length: 30 + Math.floor(rnd() * 30) }, () => Math.floor(rnd() * 80)))].map(o);
      const out = stableOrder(prev, next);
      assert.equal(out.length, next.length);
      assert.deepEqual([...ids(out)].sort((a, b) => a - b), [...ids(next)].sort((a, b) => a - b));
      // every survivor whose old slot exists in the new array kept it
      prev.forEach((p, i) => {
        if (i < next.length && next.some((n) => n.noradId === p.noradId)) assert.equal(out[i].noradId, p.noradId);
      });
    }
  });

  it('buildReplayResult applies the previous order (identity follows the slot)', () => {
    const prev = [o(3), o(1), o(2)];
    const r = buildReplayResult(resp([histObj(1), histObj(2), histObj(3), histObj(4, { propagator: 'sgp' })]), prev);
    assert.deepEqual(ids(r.result.catalogData), [3, 1, 2, 4]);
    assert.deepEqual(ids(r.result.tles), [3, 1, 2, 4]);
    assert.equal(r.result.tles[3].propagator, 'sgp');
  });
});

describe('fragments + day helpers', () => {
  it('fragmentIds keeps the pieces of the launches plus the parents', () => {
    const cat = [
      toEnrichedObject(histObj(22675, { intlDesignator: '1993-036A' })),
      toEnrichedObject(histObj(33757, { intlDesignator: '1993-036AB' })),
      toEnrichedObject(histObj(24946, { intlDesignator: '1997-051C' })),
      toEnrichedObject(histObj(25544, { intlDesignator: '1998-067A' })),
    ];
    assert.deepEqual([...fragmentIds(cat, ['1993-036'])].sort(), [22675, 33757]);
    assert.deepEqual([...fragmentIds(cat, ['1993-036', '1997-051'], [24946])].sort(), [22675, 24946, 33757]);
  });
  it('addDays / clampDay', () => {
    assert.equal(addDays('1998-12-31', 1), '1999-01-01');
    assert.equal(addDays('2000-03-01', -1), '2000-02-29');
    assert.equal(clampDay('1950-01-01', '1959-01-11', '2026-03-31'), '1959-01-11');
  });
});
