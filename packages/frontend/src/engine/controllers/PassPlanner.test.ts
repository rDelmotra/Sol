import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { computePassPlan, passPlanInputsChanged, passPlanInputsOf, PLAN_STALE_MS } from './PassPlanner';

const EPOCH_ISO = '2026-07-10T00:00:00.000Z';
const SAT = {
  noradId: 25544,
  name: 'TESTSAT',
  omm: {
    OBJECT_NAME: 'TESTSAT', OBJECT_ID: '1998-067A', EPOCH: EPOCH_ISO,
    MEAN_MOTION: 15.5, ECCENTRICITY: 0.0005, INCLINATION: 51.6, RA_OF_ASC_NODE: 100,
    ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 270, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 25544, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 100, BSTAR: 0.0001,
    MEAN_MOTION_DOT: 0.0001, MEAN_MOTION_DDOT: 0,
  },
} as unknown as EnrichedTLEObject;
const OBS = { lat: 40, lon: -105, alt: 0 };
const T0 = Date.parse(EPOCH_ISO);

describe('computePassPlan', () => {
  it('names why there is no plan', () => {
    assert.equal(computePassPlan(null, 'ground', OBS, T0).status, 'no-selection');
    assert.equal(computePassPlan(SAT, 'orbit', OBS, T0).status, 'not-on-ground');
    assert.equal(computePassPlan(SAT, 'ground', null, T0).status, 'no-location');
  });

  it('finds passes for a LEO object over a mid-latitude observer', () => {
    const plan = computePassPlan(SAT, 'ground', OBS, T0);
    assert.equal(plan.status, 'ok');
    assert.ok(plan.passes.length > 0);
  });

  it('says none-found when the propagation window is exceeded', () => {
    const plan = computePassPlan(SAT, 'ground', OBS, T0 + 400 * 86_400_000);
    assert.deepEqual(plan, { passes: [], status: 'none-found' });
  });
});

describe('passPlanInputsChanged', () => {
  const state = { selectedSatellite: SAT, observerLocation: OBS, vantage: 'ground' as const, simTimeMs: T0 };
  const base = passPlanInputsOf(state);

  it('computes the first time', () => {
    assert.equal(passPlanInputsChanged(null, base), true);
  });

  it('ignores clock movement inside one bucket', () => {
    const later = passPlanInputsOf({ ...state, simTimeMs: T0 + 1000 });
    assert.equal(passPlanInputsChanged(base, later), false);
  });

  it('fires on a new bucket, selection, observer or vantage', () => {
    assert.equal(passPlanInputsChanged(base, passPlanInputsOf({ ...state, simTimeMs: T0 + PLAN_STALE_MS })), true);
    assert.equal(passPlanInputsChanged(base, passPlanInputsOf({ ...state, selectedSatellite: null })), true);
    assert.equal(passPlanInputsChanged(base, passPlanInputsOf({ ...state, observerLocation: { ...OBS } })), true);
    assert.equal(passPlanInputsChanged(base, passPlanInputsOf({ ...state, vantage: 'orbit' })), true);
  });
});
