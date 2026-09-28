import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EARTH_RADIUS_KM,
  UMBRA_RADIUS_ER,
  geodeticToEcefEr,
  geodeticUpEcef,
  altitudeKmFromEr,
  latitudeDegFromEr,
} from './earth.js';
import { ER_KM } from './units.js';

describe('earth: constants', () => {
  it('EARTH_RADIUS_KM is 6371 (spherical figure, today)', () => {
    assert.equal(EARTH_RADIUS_KM, 6371);
  });

  it('UMBRA_RADIUS_ER = EARTH_RADIUS_KM / ER_KM', () => {
    assert.equal(UMBRA_RADIUS_ER, EARTH_RADIUS_KM / ER_KM);
  });
});

describe('earth: geodeticToEcefEr', () => {
  it('|position| = (R + alt) / ER_KM', () => {
    for (const altKm of [0, 100, 500]) {
      const p = geodeticToEcefEr({ latDeg: 37.4, lonDeg: -122.1, altKm });
      const mag = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      const expected = (EARTH_RADIUS_KM + altKm) / ER_KM;
      assert.ok(Math.abs(mag - expected) < 1e-12, `|p| ${mag} vs ${expected}`);
    }
  });

  it('defaults altKm to 0 when omitted', () => {
    const withAlt = geodeticToEcefEr({ latDeg: 10, lonDeg: 20, altKm: 0 });
    const withoutAlt = geodeticToEcefEr({ latDeg: 10, lonDeg: 20 });
    assert.deepEqual(withoutAlt, withAlt);
  });
});

describe('earth: geodeticUpEcef', () => {
  it('is a unit vector parallel to geodeticToEcefEr (spherical Earth)', () => {
    const g = { latDeg: 51.5074, lonDeg: -0.1278 };
    const p = geodeticToEcefEr(g);
    const up = geodeticUpEcef(g);
    const upMag = Math.sqrt(up.x * up.x + up.y * up.y + up.z * up.z);
    assert.ok(Math.abs(upMag - 1) < 1e-15, `|up| = ${upMag}`);

    const pMag = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    assert.ok(Math.abs(p.x / pMag - up.x) < 1e-12);
    assert.ok(Math.abs(p.y / pMag - up.y) < 1e-12);
    assert.ok(Math.abs(p.z / pMag - up.z) < 1e-12);
  });
});

describe('earth: altitudeKmFromEr', () => {
  it('recovers altitude from a radial position', () => {
    const r = { x: (EARTH_RADIUS_KM + 400) / ER_KM, y: 0, z: 0 };
    assert.ok(Math.abs(altitudeKmFromEr(r) - 400) < 1e-9);
  });

  it('is 0 at the surface (|r| = 1 ER)', () => {
    assert.ok(Math.abs(altitudeKmFromEr({ x: 1, y: 0, z: 0 })) < 1e-9);
  });
});

describe('earth: latitudeDegFromEr', () => {
  it('is 90 at the north pole, -90 at the south pole, 0 at the equator', () => {
    assert.ok(Math.abs(latitudeDegFromEr({ x: 0, y: 0, z: 1 })! - 90) < 1e-9);
    assert.ok(Math.abs(latitudeDegFromEr({ x: 0, y: 0, z: -1 })! - -90) < 1e-9);
    assert.ok(Math.abs(latitudeDegFromEr({ x: 1, y: 0, z: 0 })! - 0) < 1e-9);
  });

  it('is rotation-about-z invariant (valid on TEME input, not just ECEF)', () => {
    const ecef = { x: 0.6, y: 0.3, z: 0.5 };
    const theta = 1.234;
    const rotated = {
      x: ecef.x * Math.cos(theta) - ecef.y * Math.sin(theta),
      y: ecef.x * Math.sin(theta) + ecef.y * Math.cos(theta),
      z: ecef.z,
    };
    assert.ok(Math.abs(latitudeDegFromEr(ecef)! - latitudeDegFromEr(rotated)!) < 1e-12);
  });

  it('returns null for the zero vector', () => {
    assert.equal(latitudeDegFromEr({ x: 0, y: 0, z: 0 }), null);
  });
});
