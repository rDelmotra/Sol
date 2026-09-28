import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { observerEcef, observerTeme } from './observer.js';
import { EARTH_RADIUS_KM } from './earth.js';
import { ER_KM } from './units.js';

describe('observer: observerEcef', () => {
  it('|position| = (R+alt)/ER_KM and |up| = 1', () => {
    const g = { latDeg: 40, lonDeg: -74, altKm: 0.1 };
    const { position, up } = observerEcef(g);
    const posMag = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
    const upMag = Math.sqrt(up.x ** 2 + up.y ** 2 + up.z ** 2);
    assert.ok(Math.abs(posMag - (EARTH_RADIUS_KM + 0.1) / ER_KM) < 1e-12);
    assert.ok(Math.abs(upMag - 1) < 1e-15);
  });
});

describe('observer: observerTeme', () => {
  it('|position| = (R+alt)/ER_KM and |up| = 1, at any tMs', () => {
    const g = { latDeg: -33.8688, lonDeg: 151.2093, altKm: 0.05 };
    const tMs = Date.parse('2026-01-01T00:00:00Z');
    const { position, up } = observerTeme(g, tMs);
    const posMag = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
    const upMag = Math.sqrt(up.x ** 2 + up.y ** 2 + up.z ** 2);
    assert.ok(Math.abs(posMag - (EARTH_RADIUS_KM + 0.05) / ER_KM) < 1e-12);
    assert.ok(Math.abs(upMag - 1) < 1e-15);
  });

  it('up is parallel to position (spherical Earth: up == normalize(position))', () => {
    const g = { latDeg: 51.5074, lonDeg: -0.1278 };
    const tMs = Date.parse('2026-06-21T00:00:00Z');
    const { position, up } = observerTeme(g, tMs);
    const posMag = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
    assert.ok(Math.abs(position.x / posMag - up.x) < 1e-12);
    assert.ok(Math.abs(position.y / posMag - up.y) < 1e-12);
    assert.ok(Math.abs(position.z / posMag - up.z) < 1e-12);
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
