import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ER_KM, sgpElementsFromOmm, sgpInit, sgpPropagate } from '@orbitwatch/orbital-core';
import { buildSgpSlots, ommEpochMs, propagateSgpSlots } from './sgp-slots';
import type { TLEInput } from './sgp4-protocol';
import { normalizeOmm } from '../data/replay-catalog';
import { histObj } from '../data/replay-fixtures';

/** A 1965-like low orbit with drag in ndot/2 and no B* (an SGP-era set). */
function tle(noradId: number, propagator?: 'sgp4' | 'sgp'): TLEInput {
  const o = histObj(noradId);
  const omm = normalizeOmm({ ...o.omm, EPOCH: '1965-06-05T00:00:00', MEAN_MOTION: 16.1, ECCENTRICITY: 0.01, BSTAR: 0, MEAN_MOTION_DOT: 0.002 });
  return propagator ? { noradId, omm, propagator } : { noradId, omm };
}

describe('SGP dispatch in the SGP4 worker', () => {
  it('only the sgp-flagged slots are dispatched to SGP', () => {
    const slots = buildSgpSlots([tle(1), tle(2, 'sgp'), tle(3, 'sgp4'), tle(4, 'sgp')]);
    assert.deepEqual(slots.map((s) => s.index), [1, 3]);
    assert.ok(slots.every((s) => s.rec !== null));
    assert.equal(buildSgpSlots([tle(1), tle(2)]).length, 0, 'live catalogs carry no SGP slots');
  });

  it('overwrites just those slots with orbital-core SGP (Earth radii), leaving the SGP4 slots alone', () => {
    const tles = [tle(1), tle(2, 'sgp')];
    const slots = buildSgpSlots(tles);
    const pos = new Float32Array(6).fill(9);
    const vel = new Float32Array(6).fill(9);
    const flags = new Uint8Array([1, 1]);
    const t = Date.parse('1965-06-05T06:00:00Z');
    propagateSgpSlots(slots, t, 100 * 1440, pos, vel, flags);
    assert.deepEqual([...pos.slice(0, 3)], [9, 9, 9], 'SGP4 slot untouched');
    const ref = sgpPropagate(sgpInit(sgpElementsFromOmm(tles[1].omm as unknown as Record<string, unknown>))!, 360)!;
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(pos[3 + k] - ref.position[k] / ER_KM) < 1e-6);
      assert.ok(Math.abs(vel[3 + k] - ref.velocity[k] / ER_KM) < 1e-6);
    }
    const r = Math.hypot(pos[3], pos[4], pos[5]) * ER_KM;
    assert.ok(r > 6500 && r < 6800, `radius ${r} km`);
    assert.equal(flags[1], 1);
  });

  it('outside the propagation window or with unusable elements the slot is invalid', () => {
    const bad = tle(3, 'sgp');
    (bad.omm as unknown as Record<string, unknown>).ECCENTRICITY = 1.5;
    const slots = buildSgpSlots([tle(1, 'sgp'), bad]);
    assert.equal(slots[1].rec, null);
    const pos = new Float32Array(6).fill(1);
    const vel = new Float32Array(6).fill(1);
    const flags = new Uint8Array([1, 1]);
    propagateSgpSlots(slots, Date.parse('1965-12-31T00:00:00Z'), 60 * 1440, pos, vel, flags); // ~209 d after epoch
    assert.deepEqual([...flags], [0, 0]);
    assert.deepEqual([...pos], [0, 0, 0, 0, 0, 0]);
  });

  it('epochs parse zoneless as UTC', () => {
    assert.equal(ommEpochMs('1965-06-05T00:00:00'), Date.UTC(1965, 5, 5));
    assert.equal(ommEpochMs('1965-06-05T00:00:00Z'), Date.UTC(1965, 5, 5));
  });
});
