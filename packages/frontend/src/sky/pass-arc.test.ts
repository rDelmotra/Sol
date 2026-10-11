import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OMMJsonObject } from 'satellite.js';
import { findPasses, lookAnglesAt, type PassObserver } from './passes';
import { samplePassArc } from './pass-arc';

const EPOCH_ISO = '2026-07-10T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);
const OMM = {
  OBJECT_NAME: 'TESTSAT', OBJECT_ID: '1998-067A', EPOCH: EPOCH_ISO,
  MEAN_MOTION: 15.5, ECCENTRICITY: 0.0005, INCLINATION: 51.6, RA_OF_ASC_NODE: 100,
  ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 270, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 25544, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 100, BSTAR: 0.0001,
  MEAN_MOTION_DOT: 0.0001, MEAN_MOTION_DDOT: 0,
} as unknown as OMMJsonObject;
const OBSERVER: PassObserver = { latDeg: 40, lonDeg: -105, altKm: 0 };

describe('samplePassArc', () => {
  const pass = findPasses(OMM, OBSERVER, EPOCH_MS, 24 * 3_600_000).find((p) => !p.startClipped && !p.endClipped);

  it('has a full pass to test against', () => assert.ok(pass));

  it('ends on the geometric horizon and peaks where the pass search says', () => {
    const arc = samplePassArc(OMM, OBSERVER, pass!.horizonAosMs, pass!.horizonLosMs, 150);
    assert.ok(arc);
    assert.ok(Math.abs(arc.elevationDeg[0]) < 0.2, `start ${arc.elevationDeg[0]}`);
    assert.ok(Math.abs(arc.elevationDeg[149]) < 0.2, `end ${arc.elevationDeg[149]}`);
    const peak = Math.max(...arc.elevationDeg);
    assert.ok(Math.abs(peak - pass!.peakElevationDeg) < 0.5, `peak ${peak} vs ${pass!.peakElevationDeg}`);
  });

  it('elevation matches the pass module look angles sample by sample', () => {
    const arc = samplePassArc(OMM, OBSERVER, pass!.horizonAosMs, pass!.horizonLosMs, 11)!;
    for (let i = 0; i < 11; i++) {
      const t = pass!.horizonAosMs + (i / 10) * (pass!.horizonLosMs - pass!.horizonAosMs);
      const look = lookAnglesAt(OMM, OBSERVER, t)!;
      assert.ok(Math.abs(arc.elevationDeg[i] - look.elevationDeg) < 0.01, `sample ${i}`);
    }
  });

  it('positions are in earth-radii at orbital height', () => {
    const a = samplePassArc(OMM, OBSERVER, pass!.peakMs, pass!.peakMs + 1000, 2)!;
    const r = Math.hypot(a.ecefEr[0], a.ecefEr[1], a.ecefEr[2]);
    assert.ok(r > 1.0 && r < 1.2, `radius ${r}`);
  });

  it('returns null when nothing propagates', () => {
    const far = EPOCH_MS + 400 * 86_400_000;
    assert.equal(samplePassArc(OMM, OBSERVER, far, far + 60_000, 10), null);
  });
});
