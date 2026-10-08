// ============================================================
// Live AnalyticDataSource tests — real SGP4, real frame math, fake catalog.
//
// A hand-crafted ISS-like elset exercises the on-demand propagation path with
// RANGE assertions (physics sanity: ~7.7 km/s, ~400 km, |lat| ≤ inclination);
// synthetic buffers exercise the buffer fast-path and eclipse geometry with
// EXACT assertions; a vocab fixture exercises the dotted join paths; and one
// end-to-end program proves validator → executor → live source compose.
// ============================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as satellite from 'satellite.js';
import type { OMMJsonObject } from 'satellite.js';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import type { QueryVocab } from '../../data/query-vocab-client';
import { sunDirection, observerTeme } from '@orbitwatch/orbital-core';
import { createLiveAnalyticSource, type LiveBuffers } from './live-source';
import { validateProgram } from '@orbitwatch/analytic';
import { execute } from '@orbitwatch/analytic';

const NOW = Date.parse('2026-07-10T12:00:00Z');

function mkOmm(noradId: number, over?: Record<string, unknown>): OMMJsonObject {
  return {
    OBJECT_NAME: `TESTSAT ${noradId}`,
    OBJECT_ID: '1998-067A',
    EPOCH: '2026-07-10T00:00:00.000Z',
    MEAN_MOTION: 15.5,
    ECCENTRICITY: 0.0005,
    INCLINATION: 51.6,
    RA_OF_ASC_NODE: 100,
    ARG_OF_PERICENTER: 90,
    MEAN_ANOMALY: 270,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: noradId,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 100,
    BSTAR: 0.0001,
    MEAN_MOTION_DOT: 0.0001,
    MEAN_MOTION_DDOT: 0,
    ...over,
  } as unknown as OMMJsonObject;
}

function mkObj(noradId: number, over?: Partial<EnrichedTLEObject>, ommOver?: Record<string, unknown>): EnrichedTLEObject {
  return {
    noradId,
    name: `TESTSAT ${noradId}`,
    omm: mkOmm(noradId, ommOver),
    objectType: 'satellite',
    category: 'active_satellite',
    regime: 'LEO',
    countryCode: 'US',
    launchDate: '1998-11-20',
    period: 92.9,
    apogee: 424,
    perigee: 416,
    inclination: 51.6,
    rcsSize: 'LARGE',
    epoch: '2026-07-10T00:00:00.000Z',
    sectors: ['government'],
    purpose: 'space_science',
    status: 'in_orbit',
    launchTag: '1998-067',
    owner: 'NASAH',
    ...over,
  };
}

const VOCAB: QueryVocab = {
  launches: { '1998-067': ['Proton', 'Baikonur', ['RVSNR']] },
  orgs: {
    NASA: { n: 'NASA' },
    NASAH: { n: 'NASA Houston', p: 'NASA' },
  },
  owners: ['NASAH'],
};

describe('live source — on-demand SGP4 path (no buffers)', () => {
  const src = createLiveAnalyticSource({
    catalog: [mkObj(25544)],
    getBuffers: () => null,
    getVocab: () => VOCAB,
  });

  it('propagates a physically sane LEO state at t', () => {
    const speed = src.getField(0, 'speedKmS', NOW);
    const alt = src.getField(0, 'altitudeKm', NOW);
    const lat = src.getField(0, 'latDeg', NOW);
    const lon = src.getField(0, 'lonDeg', NOW);
    assert.ok(typeof speed === 'number' && speed > 7.4 && speed < 7.9, `speed ${String(speed)}`);
    assert.ok(typeof alt === 'number' && alt > 300 && alt < 500, `alt ${String(alt)}`);
    assert.ok(typeof lat === 'number' && Math.abs(lat) <= 52, `lat ${String(lat)}`);
    assert.ok(typeof lon === 'number' && lon >= -180 && lon <= 180, `lon ${String(lon)}`);
  });

  it('maps catalog + OMM fields (satellite→payload, elements, derived)', () => {
    assert.equal(src.getField(0, 'objectType', NOW), 'payload');
    assert.equal(src.getField(0, 'meanMotion', NOW), 15.5);
    assert.equal(src.getField(0, 'meanMotionDot', NOW), 0.0001);
    assert.equal(src.getField(0, 'meanAltitudeKm', NOW), 420);
    assert.equal(src.getField(0, 'launchYear', NOW), 1998);
    const sma = src.getField(0, 'semiMajorAxisKm', NOW);
    assert.ok(typeof sma === 'number' && Math.abs(sma - 6768) < 30, `sma ${String(sma)}`);
    assert.equal(src.getField(0, 'cospar', NOW), '1998-067A');
    assert.equal(src.getField(0, 'jcat', NOW), null); // documented gap
  });

  it('resolves dotted join paths from the vocab (incl. ownerFamily walk)', () => {
    assert.equal(src.getField(0, 'launch.lvFamily', NOW), 'Proton');
    assert.equal(src.getField(0, 'launch.siteName', NOW), 'Baikonur');
    assert.equal(src.getField(0, 'owner.name', NOW), 'NASA Houston');
    assert.equal(src.getField(0, 'ownerFamily', NOW), 'NASA'); // NASAH → parent NASA
    assert.equal(src.getField(0, 'launch.date', NOW), null); // vocab gap, honest null
  });
});

describe('live source — propagation-window guard (far-time wedge)', () => {
  // A GEO (24-h resonant) elset takes satellite.js's deep-space SDP4 path — the
  // integrator whose cost grows with |t − epoch|. Stable orbit, no drag: SGP4
  // itself still returns a valid state at ±61 d (asserted as a control below),
  // so a null from the source there can only come from the guard.
  const EPOCH_MS = Date.parse('2026-07-10T00:00:00Z');
  const DAY = 86_400_000;
  const GEO_OMM = { MEAN_MOTION: 1.0027, ECCENTRICITY: 0.0002, INCLINATION: 0.05, BSTAR: 0, MEAN_MOTION_DOT: 0 };
  const geo = mkObj(40000, { regime: 'GEO', apogee: 35800, perigee: 35780, inclination: 0.05, period: 1436 }, GEO_OMM);
  const src = createLiveAnalyticSource({ catalog: [geo], getBuffers: () => null, getVocab: () => VOCAB });

  it('inside the ±60-day window it propagates', () => {
    for (const t of [EPOCH_MS + 59 * DAY, EPOCH_MS - 59 * DAY]) {
      const alt = src.getField(0, 'altitudeKm', t);
      assert.ok(typeof alt === 'number' && alt > 35000 && alt < 36500, `alt ${String(alt)}`);
    }
  });

  it('outside the window it returns null instead of propagating', () => {
    // Control: unguarded SGP4 WOULD produce a finite state at +61 d.
    const rec = satellite.json2satrec(geo.omm);
    const raw = satellite.propagate(rec, new Date(EPOCH_MS + 61 * DAY));
    assert.ok(raw && typeof raw.position === 'object' && Number.isFinite(raw.position.x), 'control: SGP4 itself succeeds at +61 d');

    for (const t of [EPOCH_MS + 61 * DAY, EPOCH_MS - 61 * DAY, EPOCH_MS + 36_525 * DAY]) {
      assert.equal(src.getField(0, 'altitudeKm', t), null, `altitudeKm at ${new Date(t).toISOString()}`);
      assert.equal(src.getField(0, 'speedKmS', t), null);
    }
  });

  it('a non-finite instant returns null', () => {
    assert.equal(src.getField(0, 'altitudeKm', Number.NaN), null);
  });
});

describe('live source — buffer fast-path + physics geometry', () => {
  // Object 0: on the anti-solar axis at 2 ER (inside the umbra cylinder).
  // Object 1: sunward at 2 ER (fully lit). Object 2: invalid flag.
  const { x: sx, y: sy, z: sz } = sunDirection(NOW);
  const buffers: LiveBuffers = {
    positions: new Float32Array([-2 * sx, -2 * sy, -2 * sz, 2 * sx, 2 * sy, 2 * sz, 0, 0, 0]),
    velocities: new Float32Array([0, 0, 0.0012, 0, 0.0012, 0, 0, 0, 0]),
    validFlags: new Uint8Array([1, 1, 0]),
    timestamp: NOW,
  };
  const src = createLiveAnalyticSource({
    catalog: [mkObj(101), mkObj(102), mkObj(103)],
    getBuffers: () => buffers,
    getVocab: () => null,
  });

  it('reads exact state from buffers within tolerance', () => {
    const speed = src.getField(0, 'speedKmS', NOW + 2000); // within 8 s tolerance
    assert.ok(typeof speed === 'number' && Math.abs(speed - 0.0012 * 6371) < 1e-6);
    const alt = src.getField(0, 'altitudeKm', NOW);
    assert.ok(typeof alt === 'number' && Math.abs(alt - 6366.917792362153) < 1e-3, `alt ${String(alt)}`);
    // Independent (/tmp/s4b/ref.py): geodetic height of the float32-rounded 2 ER * (-sun) point,
    // 200-iteration fixed-point inverse = 6366.917792 km (6366.917708 km before float32 rounding).
  });

  it('advances the buffered state to the requested instant (r + v·dt)', () => {
    // Object 1: sunward at 2 ER with velocity 0.0012 ER/s along +y; 2 s later it is
    // 0.0024 ER further along y. Compare distance-to-object-0 geometry exactly via
    // the position the plane sees: distToKm(1, 101, t) must change by the extrapolation.
    const d0 = src.distToKm(1, 101, NOW);
    const d2 = src.distToKm(1, 101, NOW + 2000);
    assert.ok(d0 !== null && d2 !== null);
    // Independent expectation: |p1 + v1·2 − p0 − v0·2|·6371 with p0 = −2·sun, v0 = (0,0,0.0012),
    // p1 = 2·sun, v1 = (0,0.0012,0).
    const ex = [2 * sx - -2 * sx, 2 * sy + 0.0012 * 2 - -2 * sy, 2 * sz - (-2 * sz + 0.0012 * 2)];
    const expected = Math.hypot(ex[0], ex[1], ex[2]) * 6371;
    assert.ok(Math.abs(d2 - expected) < 5e-3, `d2 ${d2} vs ${expected}`); // buffers are Float32
    assert.ok(Math.abs(d2 - d0) > 1, 'extrapolation must actually move the object');
  });

  it('umbra geometry: anti-solar eclipsed, sunward lit, invalid null', () => {
    assert.equal(src.getField(0, 'eclipsed', NOW), true);
    assert.equal(src.getField(1, 'eclipsed', NOW), false);
    assert.equal(src.getField(2, 'eclipsed', NOW), null);
  });

  it('distToKm between the two live objects is 4 ER', () => {
    const d = src.distToKm(0, 102, NOW);
    assert.ok(d !== null && Math.abs(d - 4 * 6371) < 0.5, `d ${String(d)}`);
  });

  it('elevation is ~90° for a satellite straight above the observer', () => {
    const obs = { latDeg: 10, lonDeg: 20 };
    // Truly 400 km above the observer along the WGS84 normal (same lat/lon, +400 km height).
    const o = observerTeme({ ...obs, altKm: 400 }, NOW).position;
    const zenithBuffers: LiveBuffers = {
      positions: new Float32Array([o.x, o.y, o.z]),
      velocities: new Float32Array(3),
      validFlags: new Uint8Array([1]),
      timestamp: NOW,
    };
    const zsrc = createLiveAnalyticSource({
      catalog: [mkObj(201)],
      getBuffers: () => zenithBuffers,
      getVocab: () => null,
    });
    const elev = zsrc.elevationDeg(0, obs, NOW);
    assert.ok(elev !== null && elev > 89, `elev ${String(elev)}`);
    const range = zsrc.rangeKm(0, obs, NOW);
    assert.ok(range !== null && Math.abs(range - 400) < 5, `range ${String(range)}`);
  });
});

describe('live source — end-to-end with validator + executor', () => {
  it('B1 over a live-shaped catalog returns the decaying object', () => {
    const catalog = [
      mkObj(1001, undefined, { MEAN_MOTION_DOT: 0.005 }),
      mkObj(1002, undefined, { MEAN_MOTION_DOT: -0.001 }),
      mkObj(1003, undefined, { MEAN_MOTION_DOT: 0.002 }),
    ];
    const src = createLiveAnalyticSource({ catalog, getBuffers: () => null, getVocab: () => null });
    const v = validateProgram({
      v: 1, universe: 'live', timeBinding: { mode: 'now' },
      interpretation: 'decaying = mean motion increasing',
      pipeline: [
        { op: 'filter', where: { op: '>', args: [{ field: 'meanMotionDot' }, { lit: 0 }] } },
        { op: 'sort', by: 'meanMotionDot', dir: 'desc' },
      ],
      output: { shape: 'ids' },
    }, { nowMs: NOW });
    assert.equal(v.ok, true);
    if (!v.ok) return;
    const out = execute(v.program, { live: src }, { nowMs: NOW });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(Array.from(out.result.ids ?? []), [1001, 1003]);
  });
});
