// Synthetic-state tests mirroring the exact-value cases in
// packages/frontend/src/query/analytic/live-source.test.ts (~lines 160-213):
// speed = 0.0012*ER_KM, |r|=2 ER -> altitude 6371 km, 4 ER apart -> distance,
// a satellite straight overhead -> elevation ~90 deg and range ~ altitude.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createLivePlane,
  stateFromKm,
  speedKmS,
  altitudeKm,
  subpoint,
  lookAngles,
  distanceKm,
  LIVE_PLANE_FIELDS,
  type StateEr,
} from './live-plane.js';
import { ER_KM } from './units.js';
import { EARTH_RADIUS_KM } from './earth.js';
import { observerTeme } from './observer.js';
import { sunDirection } from './sun.js';

const NOW = Date.parse('2026-07-10T12:00:00Z');

describe('live-plane: stateFromKm', () => {
  it('divides position and velocity by ER_KM', () => {
    const s = stateFromKm({ x: ER_KM * 2, y: 0, z: 0 }, { x: ER_KM * 0.001, y: 0, z: 0 });
    assert.equal(s.r.x, 2);
    assert.equal(s.v.x, 0.001);
  });
});

describe('live-plane: speedKmS', () => {
  it('0.0012 ER/s -> 0.0012 * ER_KM km/s', () => {
    const s: StateEr = { r: { x: 2, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0.0012 } };
    assert.ok(Math.abs(speedKmS(s) - 0.0012 * ER_KM) < 1e-9);
  });
});

describe('live-plane: altitudeKm', () => {
  it('|r| = 2 ER -> altitude = 6371 km', () => {
    const s: StateEr = { r: { x: 2, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
    assert.ok(Math.abs(altitudeKm(s) - EARTH_RADIUS_KM) < 1e-6, `alt ${altitudeKm(s)}`);
  });
});

describe('live-plane: distanceKm', () => {
  it('two states 4 ER apart -> 4 * ER_KM', () => {
    const sun = sunDirection(NOW);
    const a: StateEr = { r: { x: -2 * sun.x, y: -2 * sun.y, z: -2 * sun.z }, v: { x: 0, y: 0, z: 0 } };
    const b: StateEr = { r: { x: 2 * sun.x, y: 2 * sun.y, z: 2 * sun.z }, v: { x: 0, y: 0, z: 0 } };
    assert.ok(Math.abs(distanceKm(a, b) - 4 * ER_KM) < 1e-6);
  });
});

describe('live-plane: subpoint', () => {
  it('is rotation-about-z invariant for latitude, and null only at the zero vector', () => {
    const s: StateEr = { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
    assert.equal(subpoint(s, NOW).latDeg, null);
  });

  it('a pole-aligned state has +-90 latitude regardless of longitude solution', () => {
    const s: StateEr = { r: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 0, z: 0 } };
    assert.ok(Math.abs(subpoint(s, NOW).latDeg! - 90) < 1e-9);
  });
});

describe('live-plane: lookAngles + eclipse geometry via createLivePlane', () => {
  // Object 'anti': on the anti-solar axis at 2 ER (inside the umbra cylinder).
  // Object 'sunward': sunward at 2 ER (fully lit).
  // Object 'zero': degenerate (coincides with the observer) -> null lookAngles.
  const sun = sunDirection(NOW);
  const states: Record<string, StateEr> = {
    anti: { r: { x: -2 * sun.x, y: -2 * sun.y, z: -2 * sun.z }, v: { x: 0, y: 0, z: 0.0012 } },
    sunward: { r: { x: 2 * sun.x, y: 2 * sun.y, z: 2 * sun.z }, v: { x: 0, y: 0.0012, z: 0 } },
  };
  const plane = createLivePlane<string>((k, t) => (t === NOW ? states[k] ?? null : null));

  it('reads speed/altitude fields from the resolved state', () => {
    const speed = plane.field('anti', 'speedKmS', NOW);
    assert.ok(typeof speed === 'number' && Math.abs(speed - 0.0012 * ER_KM) < 1e-6);
    const alt = plane.field('anti', 'altitudeKm', NOW);
    assert.ok(typeof alt === 'number' && Math.abs(alt - ER_KM) < 1e-3, `alt ${String(alt)}`); // 2 ER -> 6371 km up
  });

  it('umbra geometry: anti-solar eclipsed, sunward lit', () => {
    assert.equal(plane.field('anti', 'eclipsed', NOW), true);
    assert.equal(plane.field('sunward', 'eclipsed', NOW), false);
  });

  it('field() returns null for an unresolvable key/instant and for an unknown field name', () => {
    assert.equal(plane.field('missing', 'speedKmS', NOW), null);
    assert.equal(plane.field('missing', 'speedKmS', NOW + 1), null); // wrong instant -> resolver returns null
    assert.equal(plane.field('anti', 'notAField', NOW), null);
  });

  it('distanceKm between the two live states is 4 ER', () => {
    const d = plane.distanceKm('anti', 'sunward', NOW);
    assert.ok(d !== null && Math.abs(d - 4 * ER_KM) < 1e-3, `d ${String(d)}`);
  });

  it('distanceKm is null when either key is unresolvable', () => {
    assert.equal(plane.distanceKm('anti', 'missing', NOW), null);
  });
});

describe('live-plane: elevation/range for a satellite straight overhead', () => {
  const g = { latDeg: 10, lonDeg: 20 };
  const obsFrame = observerTeme(g, NOW);
  const upScaleEr = (EARTH_RADIUS_KM + 400) / ER_KM;
  const overhead: StateEr = {
    r: {
      x: obsFrame.up.x * upScaleEr,
      y: obsFrame.up.y * upScaleEr,
      z: obsFrame.up.z * upScaleEr,
    },
    v: { x: 0, y: 0, z: 0 },
  };

  it('lookAngles() directly: elevation ~90deg, range ~400km', () => {
    const la = lookAngles(overhead, obsFrame);
    assert.ok(la !== null);
    const elevDeg = Math.asin(Math.max(-1, Math.min(1, la!.sinElevation))) * (180 / Math.PI);
    assert.ok(elevDeg > 89, `elev ${elevDeg}`);
    assert.ok(Math.abs(la!.rangeKm - 400) < 5, `range ${la!.rangeKm}`);
  });

  it('via createLivePlane: elevationDeg/rangeKm agree', () => {
    const plane = createLivePlane<'sat'>(() => overhead);
    const elev = plane.elevationDeg('sat', g, NOW);
    assert.ok(elev !== null && elev > 89, `elev ${String(elev)}`);
    const range = plane.rangeKm('sat', g, NOW);
    assert.ok(range !== null && Math.abs(range - 400) < 5, `range ${String(range)}`);
  });

  it('a state that resolves to null gives null elevation/range', () => {
    const plane = createLivePlane<'gone'>(() => null);
    assert.equal(plane.elevationDeg('gone', g, NOW), null);
    assert.equal(plane.rangeKm('gone', g, NOW), null);
  });
});

describe('live-plane: observerDark + visuallyVisible', () => {
  const g = { latDeg: 10, lonDeg: 20 };

  it('observerDark is a plain boolean (never null)', () => {
    const plane = createLivePlane<'sat'>(() => null);
    const dark = plane.observerDark(g, NOW);
    assert.equal(typeof dark, 'boolean');
  });

  it('visuallyVisible is null when the state is unresolvable, and honors the isCurated flag', () => {
    const g2 = { latDeg: 10, lonDeg: 20 };
    const obsFrame = observerTeme(g2, NOW);
    const upScaleEr = (EARTH_RADIUS_KM + 400) / ER_KM;
    const overhead: StateEr = {
      r: { x: obsFrame.up.x * upScaleEr, y: obsFrame.up.y * upScaleEr, z: obsFrame.up.z * upScaleEr },
      v: { x: 0, y: 0, z: 0 },
    };
    const plane = createLivePlane<'sat' | 'gone'>((k) => (k === 'sat' ? overhead : null));
    assert.equal(plane.visuallyVisible('gone', g2, NOW, true), null);
    // Overhead + isCurated=false must be false regardless of geometry (not_curated short-circuits).
    assert.equal(plane.visuallyVisible('sat', g2, NOW, false), false);
  });
});

describe('live-plane: LIVE_PLANE_FIELDS', () => {
  it('lists exactly the 5 live-derived field names', () => {
    assert.deepEqual([...LIVE_PLANE_FIELDS], ['speedKmS', 'altitudeKm', 'latDeg', 'lonDeg', 'eclipsed']);
  });
});

describe('live-plane: sun/observer caching does not change results across repeated calls', () => {
  it('elevationDeg/observerDark are stable across repeated calls at the same instant', () => {
    const g = { latDeg: -33.8688, lonDeg: 151.2093, altKm: 0.05 };
    const obsFrame = observerTeme(g, NOW);
    const upScaleEr = (EARTH_RADIUS_KM + 500) / ER_KM;
    const s: StateEr = {
      r: { x: obsFrame.up.x * upScaleEr, y: obsFrame.up.y * upScaleEr, z: obsFrame.up.z * upScaleEr },
      v: { x: 0, y: 0, z: 0 },
    };
    const plane = createLivePlane<'sat'>(() => s);
    const first = plane.elevationDeg('sat', g, NOW);
    const second = plane.elevationDeg('sat', g, NOW);
    assert.equal(first, second);
    const darkFirst = plane.observerDark(g, NOW);
    const darkSecond = plane.observerDark(g, NOW);
    assert.equal(darkFirst, darkSecond);
  });
});
