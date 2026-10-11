import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ER_KM, WGS84_A_KM, WGS84_B_KM } from '@orbitwatch/orbital-core';
import { sourceToScene } from '../scene/frames';
import { liveReadoutFromScene } from './LiveKinematics';

describe('liveReadoutFromScene', () => {
  it('reads WGS84 altitude over the equator and speed in km/s', () => {
    const p = sourceToScene((WGS84_A_KM + 400) / ER_KM, 0, 0);
    const v = sourceToScene(0, 7.67 / ER_KM, 0);
    const out = liveReadoutFromScene(p, v);
    assert.ok(out);
    assert.ok(Math.abs(out.altitudeKm - 400) < 0.11, `alt ${out.altitudeKm}`);
    assert.ok(Math.abs(out.speedKmS - 7.67) < 0.0011, `speed ${out.speedKmS}`);
  });

  it('treats scene Y as the polar axis, so a polar point uses the polar radius', () => {
    // 400 km over the pole must read 400 km, not 400 + 21 (equatorial bulge).
    const out = liveReadoutFromScene({ x: 0, y: (WGS84_B_KM + 400) / ER_KM, z: 0 }, { x: 0, y: 0, z: 0 });
    assert.ok(out);
    assert.ok(Math.abs(out.altitudeKm - 400) < 0.11, `alt ${out.altitudeKm}`);
  });

  it('returns null for the worker zero vector', () => {
    assert.equal(liveReadoutFromScene({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), null);
  });
});
