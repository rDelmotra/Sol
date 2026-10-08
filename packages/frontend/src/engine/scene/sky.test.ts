import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSunDirection, getObserverSceneAnchor, getObserverEarthAnchor } from './sky';
import { gmst } from '@orbitwatch/orbital-core';

// ============================================================
// Pre-refactor pins — PROJECT_MAP/15_ORBITAL_CORE_AND_CONTRACTS.md O5.
//
// These numbers were captured from the OLD (now-deleted) frontend functions —
// the deleted frontend time.ts's getSunDirection/getGAST and the deleted
// frontend coordinates.ts's getObserverSceneAnchor/getObserverECEFPosition —
// BEFORE they were deleted, at 3 instants × 2 observers. They pin the
// render-visible behavior this refactor must not change: same satellites
// visible, same Earth rotation, same sun/terminator, same dome sky/compass
// anchoring.
//
// Tolerances: <=1e-12 ABSOLUTE for unit-vector components (sun direction,
// `up`) and <=1e-12 RELATIVE for everything else (gast, `position`).
//
// WGS84 (S4b, 2026-10-09): the sun, gast and `anchorUp` pins are unchanged
// (they do not depend on the Earth's figure; `up` is the ellipsoid normal
// (cosφcosλ, cosφsinλ, sinφ) of the GEODETIC latitude, same as before). The
// `anchorPosition`, `ecefPositionDefaultOffset` and `ecefPositionZeroOffset`
// pins were RE-PINNED to the WGS84 ellipsoid. Their independent derivation
// (/tmp/s4b/ref.py, pure python, not the code under test): reduced-latitude
// parametric forward, tanβ = (1-f)tanφ, ρ = a cosβ + h cosφ,
// z = b sinβ + h sinφ (NOT the N-based formula the code uses), / 6371 km per
// ER; TEME = rotate by the pinned gast about z; scene = (x, z, -y); the
// default-offset pin adds 0.006 ER along the scene-frame ellipsoid normal.
// The method was first checked by reproducing the OLD spherical London
// anchorPosition pin to 1e-16. `ecefUp` (normalize(position)) is gone: on an
// ellipsoid position is no longer parallel to up.
// ============================================================

interface Vec3Pin { x: number; y: number; z: number }

interface ObserverPin {
  name: string;
  latDeg: number;
  lonDeg: number;
  altKm: number;
  /** getObserverSceneAnchor(...).position (TEME, old getObserverScenePosition). */
  anchorPosition: Vec3Pin;
  /** getObserverSceneAnchor(...).up (old: anchorPosition normalized). */
  anchorUp: Vec3Pin;
  /** getObserverECEFPosition(lat, lon, alt) — default surfaceOffsetEr = 0.006. */
  ecefPositionDefaultOffset: Vec3Pin;
  /** getObserverECEFPosition(lat, lon, alt, 0) — surfaceOffsetEr = 0 (HorizonLayer's call). */
  ecefPositionZeroOffset: Vec3Pin;
}

interface InstantPin {
  iso: string;
  tMs: number;
  sun: Vec3Pin;
  gast: number;
  observers: ObserverPin[];
}

const PINS: InstantPin[] = [
  {
    iso: '2026-01-01T00:00:00.000Z',
    tMs: 1767225600000,
    sun: { x: 0.1835049166954881, y: -0.39096919643717776, z: 0.9019251814789572 },
    gast: 1.7568634098762705,
    observers: [
      {
        name: 'Mumbai', latDeg: 19.076, lonDeg: 72.8777, altKm: 0,
        anchorPosition: { x: -0.9404708220563848, y: 0.3251141020145442, z: -0.10651203585872979 },
        anchorUp: { x: -0.9390825321027938, y: 0.3268220510091861, z: -0.10635480653714821 },
        ecefPositionDefaultOffset: { x: 0.2803257291475802, y: 0.3270750343205993, z: -0.9099526991550219 },
        ecefPositionZeroOffset: { x: 0.2786562596451346, y: 0.3251141020145442, z: -0.9045335095411152 },
      },
      {
        name: 'London', latDeg: 51.5074, lonDeg: -0.1278, altKm: 0.05,
        anchorPosition: { x: -0.11414158636333287, y: 0.779926867319817, z: -0.613875968371545 },
        anchorUp: { x: -0.11377894940572372, y: 0.7826885508072845, z: -0.6119256352754987 },
        ecefPositionDefaultOffset: { x: 0.6281302332052943, y: 0.7846229986246607, z: 0.0014010661451165577 },
        ecefPositionZeroOffset: { x: 0.6243957611701928, y: 0.779926867319817, z: 0.0013927362764656482 },
      },
    ],
  },
  {
    iso: '2026-06-21T12:00:00.000Z',
    tMs: 1782043200000,
    sun: { x: -0.002598923592052463, y: 0.39772069266129717, z: -0.9175028589738458 },
    gast: 1.5655495675926014,
    observers: [
      {
        name: 'Mumbai', latDeg: 19.076, lonDeg: 72.8777, altKm: 0,
        anchorPosition: { x: -0.9030590237657893, y: 0.3251141020145442, z: -0.2833982719025702 },
        anchorUp: { x: -0.9017259597931586, y: 0.3268220510091861, z: -0.28297992933997257 },
        ecefPositionDefaultOffset: { x: 0.2803257291475802, y: 0.3270750343205993, z: -0.9099526991550219 },
        ecefPositionZeroOffset: { x: 0.2786562596451346, y: 0.3251141020145442, z: -0.9045335095411152 },
      },
      {
        name: 'London', latDeg: 51.5074, lonDeg: -0.1278, altKm: 0.05,
        anchorPosition: { x: 0.004668756281566335, y: 0.779926867319817, z: -0.6243798595377846 },
        anchorUp: { x: 0.004653923269097273, y: 0.7826885508072845, z: -0.6223961547386024 },
        ecefPositionDefaultOffset: { x: 0.6281302332052943, y: 0.7846229986246607, z: 0.0014010661451165577 },
        ecefPositionZeroOffset: { x: 0.6243957611701928, y: 0.779926867319817, z: 0.0013927362764656482 },
      },
    ],
  },
  {
    iso: '2026-09-28T18:30:00.000Z',
    tMs: 1790620200000,
    sun: { x: -0.995138161797653, y: -0.03917110062751616, z: 0.09036406260022438 },
    gast: 4.974981077230273,
    observers: [
      {
        name: 'Mumbai', latDeg: 19.076, lonDeg: 72.8777, altKm: 0,
        anchorPosition: { x: 0.9458613125341302, y: 0.3251141020145442, z: 0.034300996682253865 },
        anchorUp: { x: 0.9444650653280657, y: 0.32682205100918615, z: 0.03425036275722893 },
        ecefPositionDefaultOffset: { x: 0.2803257291475802, y: 0.3270750343205993, z: -0.9099526991550219 },
        ecefPositionZeroOffset: { x: 0.2786562596451346, y: 0.3251141020145442, z: -0.9045335095411152 },
      },
      {
        name: 'London', latDeg: 51.5074, lonDeg: -0.1278, altKm: 0.05,
        anchorPosition: { x: 0.1607385687491807, y: 0.779926867319817, z: 0.6033532288784946 },
        anchorUp: { x: 0.160227889448158, y: 0.7826885508072845, z: 0.6014363273682276 },
        ecefPositionDefaultOffset: { x: 0.6281302332052943, y: 0.7846229986246607, z: 0.0014010661451165577 },
        ecefPositionZeroOffset: { x: 0.6243957611701928, y: 0.779926867319817, z: 0.0013927362764656482 },
      },
    ],
  },
];

function assertCloseAbs(actual: number, expected: number, msg: string, tol = 1e-12): void {
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= tol, `${msg}: expected ${expected}, got ${actual} (diff ${diff}, abs tol ${tol})`);
}

function assertCloseRel(actual: number, expected: number, msg: string, relTol = 1e-12): void {
  const diff = Math.abs(actual - expected);
  const tol = Math.max(relTol, relTol * Math.abs(expected));
  assert.ok(diff <= tol, `${msg}: expected ${expected}, got ${actual} (diff ${diff}, tol ${tol})`);
}

function assertVecAbs(actual: { x: number; y: number; z: number }, expected: Vec3Pin, msg: string, tol = 1e-12): void {
  assertCloseAbs(actual.x, expected.x, `${msg}.x`, tol);
  assertCloseAbs(actual.y, expected.y, `${msg}.y`, tol);
  assertCloseAbs(actual.z, expected.z, `${msg}.z`, tol);
}

function assertVecRel(actual: { x: number; y: number; z: number }, expected: Vec3Pin, msg: string, relTol = 1e-12): void {
  assertCloseRel(actual.x, expected.x, `${msg}.x`, relTol);
  assertCloseRel(actual.y, expected.y, `${msg}.y`, relTol);
  assertCloseRel(actual.z, expected.z, `${msg}.z`, relTol);
}

describe('scene/sky — pre-refactor pins (orbital-core reproduces the deleted frontend physics math)', () => {
  for (const pin of PINS) {
    describe(`instant ${pin.iso}`, () => {
      const date = new Date(pin.tMs);

      it('getSunDirection matches the old getSunDirection (unit vector, abs tol)', () => {
        const sun = getSunDirection(date);
        assertVecAbs(sun, pin.sun, 'sun');
      });

      it('gmst(tMs) matches the old getGAST (rel tol)', () => {
        assertCloseRel(gmst(pin.tMs), pin.gast, 'gast');
      });

      for (const obs of pin.observers) {
        describe(`observer ${obs.name} (lat=${obs.latDeg}, lon=${obs.lonDeg}, alt=${obs.altKm})`, () => {
          it('getObserverSceneAnchor(...).position matches getObserverScenePosition (rel tol)', () => {
            const anchor = getObserverSceneAnchor(obs.latDeg, obs.lonDeg, obs.altKm, date);
            assertVecRel(anchor.position, obs.anchorPosition, 'anchor.position');
          });

          it('getObserverSceneAnchor(...).up matches the geodetic ellipsoid normal to 1e-12', () => {
            const anchor = getObserverSceneAnchor(obs.latDeg, obs.lonDeg, obs.altKm, date);
            assertVecAbs(anchor.up, obs.anchorUp, 'anchor.up', 1e-12);
          });

          it('getObserverEarthAnchor(lat,lon,alt) matches getObserverECEFPosition default offset (rel tol)', () => {
            const anchor = getObserverEarthAnchor(obs.latDeg, obs.lonDeg, obs.altKm);
            assertVecRel(anchor.position, obs.ecefPositionDefaultOffset, 'earthAnchor.position (default offset)');
          });

          it('getObserverEarthAnchor(lat,lon,alt,0) matches getObserverECEFPosition(...,0) (rel tol)', () => {
            const anchor = getObserverEarthAnchor(obs.latDeg, obs.lonDeg, obs.altKm, 0);
            assertVecRel(anchor.position, obs.ecefPositionZeroOffset, 'earthAnchor.position (zero offset)');
          });
        });
      }
    });
  }
});

// ============================================================
// Ported from packages/backend/tests/frontend/observer-anchor.test.ts (deleted
// in this step — visual-visibility.test.ts's move-equivalent already lives at
// packages/orbital-core/src/visibility.test.ts; these invariants are the
// observer-anchor half of that same backend test file, now exercised against
// the new scene/sky.ts + orbital-core instead of the deleted frontend coordinates.ts).
// ============================================================

describe('getObserverSceneAnchor — invariants (ported from backend tests/frontend/observer-anchor.test.ts)', () => {
  it('returns unit up vector; position is on the WGS84 ellipsoid and tilted from up by (geodetic - geocentric) latitude', () => {
    const anchor = getObserverSceneAnchor(28.6139, 77.2090, 0.25, new Date('2026-04-10T22:45:00.000Z'));
    const positionLen = anchor.position.length();
    const upLen = anchor.up.length();
    const angleDeg = Math.acos(anchor.position.clone().normalize().dot(anchor.up)) * (180 / Math.PI);

    // Independent reference (/tmp/s4b/ref.py): reduced-latitude parametric forward for
    // (28.6139N, 77.2090E, 0.25 km): |p| = 6373.514084403635 km = 1.0003946137817665 ER;
    // phi - psi = 28.6139 - asin(z/|p|) = 0.161495333949226 deg
    // (also = acos(p.up/|p|) = 0.16149533394985505 deg, computed separately).
    assert.ok(Math.abs(positionLen - 1.0003946137817665) < 1e-12);
    assert.ok(Math.abs(upLen - 1) < 1e-12);
    assert.ok(Math.abs(angleDeg - 0.161495333949226) < 1e-9, `angle ${angleDeg}`);
  });

  it('moves observer radius according to altitude', () => {
    const low = getObserverSceneAnchor(0, 0, 0, new Date('2026-04-10T22:45:00.000Z'));
    const high = getObserverSceneAnchor(0, 0, 1.5, new Date('2026-04-10T22:45:00.000Z'));

    assert.ok(high.position.length() > low.position.length());
  });
});
