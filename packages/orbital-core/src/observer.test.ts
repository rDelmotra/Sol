import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { observerEcef, observerTeme } from './observer.js';

// Independent reference (/tmp/s4b/ref.py, reduced-latitude parametric WGS84 forward, / 6371 km per ER):
//   (40N, -74E, 0.1 km)        |p| = 0.9997559037347101 ER
//   (-33.8688, 151.2093, 0.05) |p| = 1.0000916371373545 ER
const PHI_MINUS_PSI_LONDON_DEG = 0.18762217268756132; // /tmp/s4b/ref.py

describe('observer: observerEcef', () => {
  it('|position| = WGS84 ellipsoid radius and |up| = 1', () => {
    const g = { latDeg: 40, lonDeg: -74, altKm: 0.1 };
    const { position, up } = observerEcef(g);
    const posMag = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
    const upMag = Math.sqrt(up.x ** 2 + up.y ** 2 + up.z ** 2);
    assert.ok(Math.abs(posMag - 0.9997559037347101) < 1e-12);
    assert.ok(Math.abs(upMag - 1) < 1e-15);
  });
});

describe('observer: observerTeme', () => {
  it('|position| = WGS84 ellipsoid radius and |up| = 1, at any tMs', () => {
    const g = { latDeg: -33.8688, lonDeg: 151.2093, altKm: 0.05 };
    const tMs = Date.parse('2026-01-01T00:00:00Z');
    const { position, up } = observerTeme(g, tMs);
    const posMag = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
    const upMag = Math.sqrt(up.x ** 2 + up.y ** 2 + up.z ** 2);
    assert.ok(Math.abs(posMag - 1.0000916371373545) < 1e-12);
    assert.ok(Math.abs(upMag - 1) < 1e-15);
  });

  it('up is the ellipsoid normal: tilted from position by (geodetic - geocentric) latitude', () => {
    const g = { latDeg: 51.5074, lonDeg: -0.1278 };
    const tMs = Date.parse('2026-06-21T00:00:00Z');
    const { position, up } = observerTeme(g, tMs);
    const posMag = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
    const cos = (position.x * up.x + position.y * up.y + position.z * up.z) / posMag;
    const angleDeg = Math.acos(cos) * (180 / Math.PI);
    // Independent: phi - psi = 51.5074 - asin(z/|p|) computed in /tmp/s4b/ref.py.
    assert.ok(Math.abs(angleDeg - PHI_MINUS_PSI_LONDON_DEG) < 1e-9, `angle ${angleDeg}`);
  });

  it('rotates with tMs (fixed geodetic point, different TEME position 6h later)', () => {
    const g = { latDeg: 0, lonDeg: 0, altKm: 0 };
    const t1 = Date.parse('2026-01-01T00:00:00Z');
    const t2 = t1 + 6 * 3600_000;
    const p1 = observerTeme(g, t1).position;
    const p2 = observerTeme(g, t2).position;
    assert.ok(Math.abs(p1.x - p2.x) > 0.1 || Math.abs(p1.y - p2.y) > 0.1);
  });
});
