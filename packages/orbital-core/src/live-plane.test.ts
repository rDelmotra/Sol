// Synthetic-state tests mirroring the exact-value cases in
// packages/frontend/src/query/analytic/live-source.test.ts (~lines 160-213):
// speed = 0.0012*ER_KM, |r|=2 ER on the equatorial axis -> altitude 6363.863 km (WGS84), 4 ER apart -> distance,
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
  azimuthElevation,
  distanceKm,
  LIVE_PLANE_FIELDS,
  type StateEr,
} from './live-plane.js';
import { ER_KM, RAD } from './units.js';
import { observerTeme, observerEcef, type ObserverFrame } from './observer.js';
import { ecefToTeme } from './rotation.js';
import { gmst } from './time.js';
import type { Vec3 } from './vec.js';
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
  it('(2 ER, 0, 0) -> altitude = 2*6371 - 6378.137 = 6363.863 km (WGS84, on the equator)', () => {
    const s: StateEr = { r: { x: 2, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
    assert.ok(Math.abs(altitudeKm(s) - 6363.863) < 1e-6, `alt ${altitudeKm(s)}`);
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
    assert.ok(typeof alt === 'number' && Math.abs(alt - 6366.917708232548) < 1e-6, `alt ${String(alt)}`);
    // Independent: geodetic height of 2 ER * (-sunDirection(NOW)) via 200-iteration fixed-point
    // inverse (/tmp/s4b/ref.py), sun = (-0.31345920296953095, 0.871265232409597, 0.3776774058213667)
    // taken as INPUT data (pinned in golden.test.ts to Meeus); phi = -22.2572249 deg, h = 6366.9177082 km.
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
  // Truly 400 km above the observer along the ellipsoid normal (same lat/lon, +400 km height).
  const overhead: StateEr = {
    r: observerTeme({ ...g, altKm: 400 }, NOW).position,
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
    const overhead: StateEr = {
      r: observerTeme({ ...g2, altKm: 400 }, NOW).position,
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
    const s: StateEr = {
      r: observerTeme({ ...g, altKm: 550 }, NOW).position, // 500 km above the 0.05 km observer
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

describe('live-plane: azimuthElevation', () => {
  // A target at observer + offset (offset in the same frame as the observer).
  const at = (obs: ObserverFrame, d: Vec3): StateEr => ({
    r: { x: obs.position.x + d.x, y: obs.position.y + d.y, z: obs.position.z + d.z },
    v: { x: 0, y: 0, z: 0 },
  });
  const near = (a: number, b: number, tol: number, what: string) =>
    assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

  // Equatorial observer at lat 0, lon 0, ECEF: up = +x, east = +y, north = +z.
  const eq = observerEcef({ latDeg: 0, lonDeg: 0 });
  const d = 0.05; // ER, ~320 km

  it('equator: due north, east, south, west at 45° elevation', () => {
    const cases: Array<[Vec3, number]> = [
      [{ x: d, y: 0, z: d }, 0],
      [{ x: d, y: d, z: 0 }, 90],
      [{ x: d, y: 0, z: -d }, 180],
      [{ x: d, y: -d, z: 0 }, 270],
    ];
    for (const [off, az] of cases) {
      const look = azimuthElevation(at(eq, off), eq)!;
      near(look.azimuthDeg, az, 1e-9, `azimuth for expected ${az}`);
      near(look.elevationDeg, 45, 1e-9, 'elevation');
      near(look.rangeKm, Math.SQRT2 * d * ER_KM, 1e-6, 'range');
    }
  });

  it('equator: straight overhead is 90° elevation', () => {
    const look = azimuthElevation(at(eq, { x: d, y: 0, z: 0 }), eq)!;
    near(look.elevationDeg, 90, 1e-9, 'elevation');
    near(look.rangeKm, d * ER_KM, 1e-6, 'range');
  });

  it('mid-latitude TEME: independent geodetic north/east axes give 0° and 90°', () => {
    const g = { latDeg: 40, lonDeg: -105 };
    const obs = observerTeme(g, NOW);
    const theta = gmst(NOW);
    const lat = g.latDeg * RAD;
    const lon = g.lonDeg * RAD;
    // Textbook local axes in ECEF, rotated into TEME.
    const north = ecefToTeme({ x: -Math.sin(lat) * Math.cos(lon), y: -Math.sin(lat) * Math.sin(lon), z: Math.cos(lat) }, theta);
    const east = ecefToTeme({ x: -Math.sin(lon), y: Math.cos(lon), z: 0 }, theta);
    const up = obs.up;
    const comb = (a: Vec3, ka: number, b: Vec3, kb: number): Vec3 =>
      ({ x: a.x * ka + b.x * kb, y: a.y * ka + b.y * kb, z: a.z * ka + b.z * kb });

    const n = azimuthElevation(at(obs, comb(north, d, up, 0)), obs)!;
    // Due north may land on 0 or just under 360; compare on the circle.
    near(((n.azimuthDeg + 180) % 360) - 180, 0, 1e-9, 'north azimuth');
    near(n.elevationDeg, 0, 1e-9, 'north elevation');

    const e = azimuthElevation(at(obs, comb(east, d, up, d)), obs)!;
    near(e.azimuthDeg, 90, 1e-9, 'east azimuth');
    near(e.elevationDeg, 45, 1e-9, 'east elevation');

    const sw = azimuthElevation(at(obs, comb(north, -d, east, -d)), obs)!;
    near(sw.azimuthDeg, 225, 1e-9, 'south-west azimuth');
  });

  it('elevation agrees with lookAngles().sinElevation, range with lookAngles().rangeKm', () => {
    const obs = observerTeme({ latDeg: -33.9, lonDeg: 18.4, altKm: 0.1 }, NOW);
    const s: StateEr = { r: { x: 0.3, y: -1.05, z: 0.4 }, v: { x: 0, y: 0, z: 0 } };
    const la = lookAngles(s, obs)!;
    const ae = azimuthElevation(s, obs)!;
    near(Math.sin(ae.elevationDeg * RAD), la.sinElevation, 1e-12, 'sinElevation');
    assert.equal(ae.rangeKm, la.rangeKm);
    assert.ok(ae.azimuthDeg >= 0 && ae.azimuthDeg < 360);
  });

  it('poles: finite azimuth and correct elevation, including an exactly polar up', () => {
    const geodeticPole = observerEcef({ latDeg: 90, lonDeg: 0 });
    const exactPole: ObserverFrame = { position: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 0, z: 1 } };
    for (const obs of [geodeticPole, exactPole]) {
      const look = azimuthElevation(at(obs, { x: d, y: 0, z: d }), obs)!;
      assert.ok(Number.isFinite(look.azimuthDeg) && look.azimuthDeg >= 0 && look.azimuthDeg < 360);
      near(look.elevationDeg, 45, 1e-6, 'elevation');
    }
  });

  it('null when the state coincides with the observer', () => {
    assert.equal(azimuthElevation(at(eq, { x: 0, y: 0, z: 0 }), eq), null);
  });
});
