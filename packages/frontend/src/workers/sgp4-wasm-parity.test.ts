// ============================================================
// wasm-sgp4 ↔ satellite.js parity — the "copied engine, same physics" proof.
//
// Loads the committed WASM binary via initSync (no browser needed) and runs
// the SAME OMM records + instants through both engines. NOTE the engines do
// NOT share a gravity model: the Rust crate's `Constants::from_elements` uses
// WGS84 constants while satellite.js is hard-coded WGS72 (measured 2026-10-09:
// LEO median ~37 m now, ~250 m at +7 d; worst LEO ~1.3 km now). The tolerance
// below (1e-4 ER ≈ 640 m, ±2 d) is deliberately loose for that reason, while a
// wrong frame / epoch bug (km-scale) still fails loudly. See PROJECT_MAP/16.
//
// Fixtures are real catalog records chosen to cover the three propagator
// regimes: ISS (near-earth + drag), SYNCOM 2 (GEO — 24 h resonant SDP4),
// LAGEOS 2 (deep-space, 6.5 rev/day). EPOCH strings keep their trailing 'Z'
// exactly as /api/tle/all serves them — the strip is part of what's tested.
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as satellite from 'satellite.js';
import type { OMMJsonObject } from 'satellite.js';
import { initSync, Simulator } from 'wasm-sgp4';
import { ER_KM, MAX_TSINCE_MIN } from '@orbitwatch/orbital-core';

const require = createRequire(import.meta.url);
const wasmPath = join(dirname(require.resolve('wasm-sgp4')), 'wasm_sgp4_bg.wasm');
const wasm = initSync({ module: readFileSync(wasmPath) });

const ISS: OMMJsonObject = { OBJECT_NAME: 'ISS (ZARYA)', OBJECT_ID: '1998-067A', EPOCH: '2026-07-18T20:42:49.520160Z', MEAN_MOTION: 15.49045026, ECCENTRICITY: 0.00068076, INCLINATION: 51.6317, RA_OF_ASC_NODE: 143.3357, ARG_OF_PERICENTER: 311.9483, MEAN_ANOMALY: 48.0925, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: 25544, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 57666, BSTAR: 8.19388e-5, MEAN_MOTION_DOT: 4.074e-5, MEAN_MOTION_DDOT: 0 } as unknown as OMMJsonObject;
const SYNCOM2: OMMJsonObject = { OBJECT_NAME: 'SYNCOM 2 (A 26)', OBJECT_ID: '1963-031A', EPOCH: '2026-07-17T18:55:38.750880Z', MEAN_MOTION: 1.00266476, ECCENTRICITY: 0.00073267, INCLINATION: 29.9172, RA_OF_ASC_NODE: 300.0136, ARG_OF_PERICENTER: 203.5635, MEAN_ANOMALY: 141.6747, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: 634, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 23066, BSTAR: 0, MEAN_MOTION_DOT: -2.2e-7, MEAN_MOTION_DDOT: 0 } as unknown as OMMJsonObject;
const LAGEOS2: OMMJsonObject = { OBJECT_NAME: 'LAGEOS 2', OBJECT_ID: '1992-070B', EPOCH: '2026-07-03T12:24:12.574080Z', MEAN_MOTION: 6.47293801, ECCENTRICITY: 0.013793, INCLINATION: 52.6512, RA_OF_ASC_NODE: 256.345, ARG_OF_PERICENTER: 194.4924, MEAN_ANOMALY: 154.2737, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: 22195, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 79647, BSTAR: 0, MEAN_MOTION_DOT: -9e-8, MEAN_MOTION_DDOT: 0 } as unknown as OMMJsonObject;

const FIXTURES = [ISS, SYNCOM2, LAGEOS2];
const ISS_EPOCH_MS = Date.parse(ISS.EPOCH as string);

/** Mirror the worker's Z-strip, then feed the WASM engine. */
function initSim(records: OMMJsonObject[]): { sim: Simulator; valid: number } {
  const sim = new Simulator();
  const stripped = records.map((omm) => {
    const o = { ...omm };
    if (typeof o.EPOCH === 'string' && o.EPOCH.endsWith('Z')) o.EPOCH = o.EPOCH.slice(0, -1);
    return o;
  });
  const valid = sim.init(JSON.stringify(stripped));
  return { sim, valid };
}

function readBuffers(sim: Simulator, count: number) {
  return {
    positions: new Float32Array(wasm.memory.buffer, sim.positions_ptr(), count * 3),
    velocities: new Float32Array(wasm.memory.buffer, sim.velocities_ptr(), count * 3),
    validFlags: new Uint8Array(wasm.memory.buffer, sim.valid_flags_ptr(), count),
  };
}

test('wasm positions/velocities match satellite.js across propagator regimes', () => {
  const { sim, valid } = initSim(FIXTURES);
  assert.equal(valid, FIXTURES.length);

  const POS_TOL_ER = 1e-4;   // ~640 m
  const VEL_TOL = 1e-6;      // ER/s (~6 mm/s)

  for (const offsetMin of [0, 30, 720, -720, 2880]) {
    const tMs = ISS_EPOCH_MS + offsetMin * 60_000;
    sim.propagate(tMs, MAX_TSINCE_MIN);
    const { positions, velocities, validFlags } = readBuffers(sim, FIXTURES.length);

    FIXTURES.forEach((omm, i) => {
      const rec = satellite.json2satrec(omm);
      const r = satellite.propagate(rec, new Date(tMs));
      const p = r?.position;
      const v = r?.velocity;
      assert.ok(p && typeof p !== 'boolean' && v && typeof v !== 'boolean', `satellite.js valid ${omm.OBJECT_NAME}`);
      assert.equal(validFlags[i], 1, `wasm valid ${omm.OBJECT_NAME} @${offsetMin}min`);

      const i3 = i * 3;
      const exp = [p.x, p.y, p.z].map((k) => k / ER_KM);
      const expV = [v.x, v.y, v.z].map((k) => k / ER_KM);
      for (let a = 0; a < 3; a++) {
        assert.ok(Math.abs(positions[i3 + a] - exp[a]) < POS_TOL_ER,
          `${omm.OBJECT_NAME} pos[${a}] @${offsetMin}min: wasm=${positions[i3 + a]} js=${exp[a]}`);
        assert.ok(Math.abs(velocities[i3 + a] - expV[a]) < VEL_TOL,
          `${omm.OBJECT_NAME} vel[${a}] @${offsetMin}min: wasm=${velocities[i3 + a]} js=${expV[a]}`);
      }
    });
  }
});

test('one corrupt record invalidates only its own slot', () => {
  const corrupt = { OBJECT_NAME: 'BROKEN', EPOCH: 'not-a-date', MEAN_MOTION: 'garbage' } as unknown as OMMJsonObject;
  const { sim, valid } = initSim([ISS, corrupt, SYNCOM2]);
  assert.equal(valid, 2);

  sim.propagate(ISS_EPOCH_MS, MAX_TSINCE_MIN);
  const { positions, validFlags } = readBuffers(sim, 3);
  assert.equal(validFlags[0], 1);
  assert.equal(validFlags[1], 0);
  assert.equal(validFlags[2], 1);
  // Invalid slot is zeroed, not stale.
  assert.deepEqual([positions[3], positions[4], positions[5]], [0, 0, 0]);
});

test('propagation window cap marks far instants invalid (and zeroes them)', () => {
  const { sim } = initSim([ISS]);
  // In-window first so the slot holds a real position…
  sim.propagate(ISS_EPOCH_MS, MAX_TSINCE_MIN);
  let b = readBuffers(sim, 1);
  assert.equal(b.validFlags[0], 1);
  // …then 61 days out: flagged invalid AND zeroed (no stale coordinates).
  sim.propagate(ISS_EPOCH_MS + 61 * 1440 * 60_000, MAX_TSINCE_MIN);
  b = readBuffers(sim, 1);
  assert.equal(b.validFlags[0], 0);
  assert.deepEqual([b.positions[0], b.positions[1], b.positions[2]], [0, 0, 0]);
});

test('non-finite timestamp is rejected (NaN must not reach SGP4)', () => {
  const { sim } = initSim(FIXTURES);
  sim.propagate(Number.NaN, MAX_TSINCE_MIN);
  const { validFlags } = readBuffers(sim, FIXTURES.length);
  assert.deepEqual([...validFlags], [0, 0, 0]);
});
