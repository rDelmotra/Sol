import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { orbitPosition } from '@orbitwatch/orbital-core';
import { orbitElementsFromOmm, ommEpochMs } from './orbit-elements';

const OMM = {
  MEAN_MOTION: 15,
  ECCENTRICITY: 0.001,
  MEAN_ANOMALY: 10,
  INCLINATION: 51.6,
  RA_OF_ASC_NODE: 100,
  ARG_OF_PERICENTER: 90,
  EPOCH: '2026-01-01T00:00:00',
};

describe('sky/orbit-elements', () => {
  it('a zoneless EPOCH is read as UTC, not local time', () => {
    assert.equal(ommEpochMs('2026-01-01T00:00:00'), Date.UTC(2026, 0, 1));
    assert.equal(ommEpochMs('2026-01-01T00:00:00.123456'), Date.UTC(2026, 0, 1, 0, 0, 0, 123));
    const a = orbitPosition(orbitElementsFromOmm(OMM)!, Date.parse('2026-01-01T00:10:00Z'))!;
    const b = orbitPosition(orbitElementsFromOmm({ ...OMM, EPOCH: '2026-01-01T00:00:00Z' })!, Date.parse('2026-01-01T00:10:00Z'))!;
    assert.equal(a.trueAnomaly, b.trueAnomaly);
  });

  it('an explicit zone is respected', () => {
    assert.equal(ommEpochMs('2026-01-01T02:00:00+02:00'), Date.UTC(2026, 0, 1));
  });

  it('maps fields and accepts numeric strings', () => {
    const el = orbitElementsFromOmm({ ...OMM, MEAN_MOTION: '15', INCLINATION: '51.6' })!;
    assert.deepEqual(el, {
      meanMotionRevPerDay: 15,
      eccentricity: 0.001,
      meanAnomalyDeg: 10,
      inclinationDeg: 51.6,
      raanDeg: 100,
      argPerigeeDeg: 90,
      epochMs: Date.UTC(2026, 0, 1),
    });
  });

  it('null when a field is missing, empty or unparseable', () => {
    assert.equal(orbitElementsFromOmm({ ...OMM, ECCENTRICITY: undefined }), null);
    assert.equal(orbitElementsFromOmm({ ...OMM, INCLINATION: '' }), null);
    assert.equal(orbitElementsFromOmm({ ...OMM, EPOCH: 'not-a-date' }), null);
    assert.equal(orbitElementsFromOmm({}), null);
  });
});
