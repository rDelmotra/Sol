/**
 * Golden-vector regression test for J2000/ICRF → TEME frame conversion.
 *
 * Purpose:
 * - Validate that the precession/nutation/equation-of-equinoxes matrix chain
 *   produces consistent, known-good outputs for locked input vectors.
 * - Catch sign errors, matrix order bugs, and coefficient typos that would
 *   silently shift DSO positions by hundreds of km.
 *
 * Golden vectors lock in the algorithmic output of the full 106-term IAU 1980 
 * nutation series (as strictly implemented from the ERFA/SOFA standard). 
 * Any change to convert.ts that inadvertently alters the frame conversion 
 * will break these tests.
 *
 * Test cases:
 * 1. Vallado Example 3-15 (April 6, 2004) — classic reference epoch
 * 2. J2000.0 epoch — near-identity sanity check
 * 3. Modern 2026 epoch with L2-scale distances — regression for DSO use case
 *
 * Note on precision:
 * This implementation uses the full 106-term IAU 1980 nutation series, ensuring
 * high precision (sub-km accuracy even at deep-space distances) strictly matching 
 * the IAU standard without the cross-coupling errors of the low-precision formula.
 *
 * Run: npx tsx --test packages/backend/tests/dso/normalize/convert.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../../../src/dso/normalize/convert.ts';

const {
  computePrecessionMatrix,
  computeNutationTerms,
  computeNutationMatrix,
  computeJ2000ToTemeMatrix,
  computeJ2000ToTemeMatrixDerivative,
  convertSampleToTemeState,
  convertProviderFetchToDsoSnapshot,
  multiplyMatrixVector,
  ER_KM,
  J2000_JULIAN_DAY,
} = __testing__;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];

function vectorError(actual: Vec3, expected: Vec3): number {
  return Math.sqrt(
    (actual[0] - expected[0]) ** 2 +
    (actual[1] - expected[1]) ** 2 +
    (actual[2] - expected[2]) ** 2,
  );
}

function assertVectorClose(
  actual: Vec3,
  expected: Vec3,
  toleranceKm: number,
  label: string,
): void {
  const err = vectorError(actual, expected);
  assert.ok(
    err < toleranceKm,
    `${label}: error ${err.toFixed(6)} km exceeds tolerance ${toleranceKm} km.\n` +
    `  actual:   [${actual.map(v => v.toFixed(8)).join(', ')}]\n` +
    `  expected: [${expected.map(v => v.toFixed(8)).join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// Test Case 1: Vallado Example 3-15
// April 6, 2004 07:51:28.386009 UTC → JD(TDB) ≈ 2453101.82741184
// ---------------------------------------------------------------------------

const JD_VALLADO = 2453101.82741184;

const VALLADO_R_J2000: Vec3 = [5102.50896, 6123.01152, 6378.13630];
const VALLADO_V_J2000: Vec3 = [-4.7432196, 0.7905366, 5.5337561];

// Golden output from our 106-term nutation model (ERFA/SOFA standard)
const VALLADO_R_TEME_GOLDEN: Vec3 = [5111.80327745, 6117.35959270, 6376.11710122];
const VALLADO_V_TEME_GOLDEN: Vec3 = [-4.73995350, 0.79537756, 5.53586040];

describe('J2000 → TEME frame conversion', () => {

  describe('Test Case 1: Vallado Example 3-15', () => {

    it('position matches golden vector within 0.001 km', () => {
      const C = computeJ2000ToTemeMatrix(JD_VALLADO);
      const r_teme = multiplyMatrixVector(C, VALLADO_R_J2000) as Vec3;
      assertVectorClose(r_teme, VALLADO_R_TEME_GOLDEN, 0.001, 'Vallado position');
    });

    it('velocity matches golden vector within 0.000001 km/s', () => {
      const C = computeJ2000ToTemeMatrix(JD_VALLADO);
      const Cdot = computeJ2000ToTemeMatrixDerivative(JD_VALLADO);
      const v_rot = multiplyMatrixVector(C, VALLADO_V_J2000) as Vec3;
      const v_frame = multiplyMatrixVector(Cdot, VALLADO_R_J2000) as Vec3;
      const v_teme: Vec3 = [
        v_rot[0] + v_frame[0],
        v_rot[1] + v_frame[1],
        v_rot[2] + v_frame[2],
      ];
      assertVectorClose(v_teme, VALLADO_V_TEME_GOLDEN, 0.000001, 'Vallado velocity');
    });

  });

  // -------------------------------------------------------------------------
  // Test Case 2: J2000.0 epoch — near-identity check
  // At J2000.0, precession angles are zero and nutation is near-zero.
  // The TEME output should be very close to the J2000 input.
  // -------------------------------------------------------------------------

  describe('Test Case 2: J2000.0 epoch (near-identity)', () => {

    const R_TEST: Vec3 = [10000, 20000, 30000];
    const R_TEME_GOLDEN: Vec3 = [10003.28280744, 19999.60086903, 29999.17162446];

    it('position deviates from input by < 5 km', () => {
      const C = computeJ2000ToTemeMatrix(J2000_JULIAN_DAY);
      const r_teme = multiplyMatrixVector(C, R_TEST) as Vec3;
      // At J2000.0 epoch, nutation is the only contributor (~few arcsec)
      const err = vectorError(r_teme, R_TEST);
      assert.ok(err < 5, `J2000.0 identity deviation ${err.toFixed(6)} km exceeds 5 km`);
    });

    it('position matches golden vector within 0.001 km', () => {
      const C = computeJ2000ToTemeMatrix(J2000_JULIAN_DAY);
      const r_teme = multiplyMatrixVector(C, R_TEST) as Vec3;
      assertVectorClose(r_teme, R_TEME_GOLDEN, 0.001, 'J2000.0 epoch position');
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 3: Modern epoch (2026) with L2-scale distances
  // JD(TDB) = 2461040.0 (~2026-Apr-08 12:00 TDB)
  // Synthetic JWST-like position at ~1.5M km from Earth
  // -------------------------------------------------------------------------

  describe('Test Case 3: 2026 epoch with L2-scale position', () => {

    const JD_2026 = 2461040.0;
    const R_J2000: Vec3 = [-1200000.0, 800000.0, 350000.0];
    const V_J2000: Vec3 = [0.2, -0.3, 0.1];
    const R_TEME_GOLDEN: Vec3 = [-1194481.91060671, 806890.90521940, 353043.95237358];
    const V_TEME_GOLDEN: Vec3 = [0.19851658, -0.30115384, 0.09948550];

    it('position matches golden vector within 0.01 km', () => {
      const C = computeJ2000ToTemeMatrix(JD_2026);
      const r_teme = multiplyMatrixVector(C, R_J2000) as Vec3;
      assertVectorClose(r_teme, R_TEME_GOLDEN, 0.01, '2026 L2 position');
    });

    it('velocity (with Ċ·r term) matches golden vector within 0.000001 km/s', () => {
      const C = computeJ2000ToTemeMatrix(JD_2026);
      const Cdot = computeJ2000ToTemeMatrixDerivative(JD_2026);
      const v_rot = multiplyMatrixVector(C, V_J2000) as Vec3;
      const v_frame = multiplyMatrixVector(Cdot, R_J2000) as Vec3;
      const v_teme: Vec3 = [
        v_rot[0] + v_frame[0],
        v_rot[1] + v_frame[1],
        v_rot[2] + v_frame[2],
      ];
      assertVectorClose(v_teme, V_TEME_GOLDEN, 0.000001, '2026 L2 velocity');
    });

    it('precession angles are non-trivial for 2026', () => {
      // 26 years from J2000 → precession should be measurable
      const C = computePrecessionMatrix(JD_2026);
      // Off-diagonal elements should be clearly non-zero
      assert.ok(Math.abs(C[0][1]) > 1e-4, 'Precession should have visible off-diagonal terms');
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 4: convertSampleToTemeState end-to-end
  // Verifies the full pipeline: frame conversion + unit scaling (km → ER)
  // -------------------------------------------------------------------------

  describe('Test Case 4: convertSampleToTemeState end-to-end', () => {

    it('converts J2000 km to TEME earth_radii correctly', () => {
      const sample = {
        julianDayTdb: JD_VALLADO,
        calendarTimestampTdb: '2004-04-06T07:51:28.386',
        x: VALLADO_R_J2000[0],
        y: VALLADO_R_J2000[1],
        z: VALLADO_R_J2000[2],
        vx: VALLADO_V_J2000[0],
        vy: VALLADO_V_J2000[1],
        vz: VALLADO_V_J2000[2],
      };

      const result = convertSampleToTemeState(sample);

      // result is [timestampIso, x, y, z, vx, vy, vz] in earth_radii
      assert.equal(typeof result[0], 'string', 'First element should be ISO timestamp');

      const r_teme_er: Vec3 = [result[1] as number, result[2] as number, result[3] as number];
      const r_teme_km: Vec3 = [
        r_teme_er[0] * ER_KM,
        r_teme_er[1] * ER_KM,
        r_teme_er[2] * ER_KM,
      ];

      assertVectorClose(r_teme_km, VALLADO_R_TEME_GOLDEN, 0.001, 'end-to-end position (km)');

      const v_teme_er: Vec3 = [result[4] as number, result[5] as number, result[6] as number];
      const v_teme_kms: Vec3 = [
        v_teme_er[0] * ER_KM,
        v_teme_er[1] * ER_KM,
        v_teme_er[2] * ER_KM,
      ];

      assertVectorClose(v_teme_kms, VALLADO_V_TEME_GOLDEN, 0.000001, 'end-to-end velocity (km/s)');
    });
  });

  describe('Test Case 5: snapshot shaping', () => {

    it('preserves provider source frame metadata in the published snapshot', () => {
      const snapshot = convertProviderFetchToDsoSnapshot(
        {
          dsoId: 'jwst',
          slug: 'jwst',
          displayName: 'James Webb Space Telescope',
          provider: 'horizons',
          providerObjectId: '-170',
          enabled: true,
          targetBody: 'other',
          regime: 'OTHER',
          sampleStepSec: 600,
          refreshIntervalSec: 21600,
          validPastWindowSec: 21600,
          validFutureWindowSec: 259200,
          mission: 'JWST',
          description: null,
          launchDate: null,
          searchAliases: ['jwst'],
        },
        {
          provider: 'horizons',
          providerObjectId: '-170',
          sourceFrame: 'ICRF',
          sourceUnits: 'KM-S',
          timeScale: 'TDB',
          fetchedAt: '2026-04-09T12:00:00.000Z',
          sourceRevisionAt: null,
          samples: [
            {
              julianDayTdb: JD_VALLADO,
              calendarTimestampTdb: '2004-04-06T07:51:28.386',
              x: VALLADO_R_J2000[0],
              y: VALLADO_R_J2000[1],
              z: VALLADO_R_J2000[2],
              vx: VALLADO_V_J2000[0],
              vy: VALLADO_V_J2000[1],
              vz: VALLADO_V_J2000[2],
            },
            {
              julianDayTdb: JD_VALLADO + (600 / 86400),
              calendarTimestampTdb: '2004-04-06T08:01:28.386',
              x: VALLADO_R_J2000[0] + 1,
              y: VALLADO_R_J2000[1] + 1,
              z: VALLADO_R_J2000[2] + 1,
              vx: VALLADO_V_J2000[0],
              vy: VALLADO_V_J2000[1],
              vz: VALLADO_V_J2000[2],
            },
          ],
        },
        new Date('2004-04-06T07:50:00.000Z'),
        new Date('2004-04-06T08:05:00.000Z'),
      );

      assert.equal(snapshot.sourceFrame, 'ICRF');
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 6: Precession sub-component checks
  // -------------------------------------------------------------------------

  describe('Test Case 6: Precession matrix properties', () => {

    it('precession matrix is orthogonal (R^T R ≈ I)', () => {
      const P = computePrecessionMatrix(JD_VALLADO);
      // Compute P^T * P
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let dot = 0;
          for (let k = 0; k < 3; k++) dot += P[k][i] * P[k][j];
          const expected = i === j ? 1 : 0;
          assert.ok(
            Math.abs(dot - expected) < 1e-12,
            `P^T*P[${i}][${j}] = ${dot}, expected ${expected}`,
          );
        }
      }
    });

    it('precession at J2000.0 is identity', () => {
      const P = computePrecessionMatrix(J2000_JULIAN_DAY);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const expected = i === j ? 1 : 0;
          assert.ok(
            Math.abs(P[i][j] - expected) < 1e-15,
            `P_J2000[${i}][${j}] = ${P[i][j]}, expected ${expected}`,
          );
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 7: Nutation sub-component checks
  // -------------------------------------------------------------------------

  describe('Test Case 7: Nutation terms sanity', () => {

    it('nutation Δψ is in expected range (~±20 arcsec)', () => {
      const terms = computeNutationTerms(JD_VALLADO);
      const dpsiArcsec = terms.deltaPsiRad / ((Math.PI / 180) / 3600);
      assert.ok(
        Math.abs(dpsiArcsec) < 25,
        `|Δψ| = ${Math.abs(dpsiArcsec).toFixed(2)} arcsec, expected < 25`,
      );
    });

    it('mean obliquity is ~23.44° at modern epochs', () => {
      const terms = computeNutationTerms(JD_VALLADO);
      const obliquityDeg = terms.meanObliquityRad * (180 / Math.PI);
      assert.ok(
        obliquityDeg > 23.4 && obliquityDeg < 23.5,
        `Mean obliquity = ${obliquityDeg.toFixed(4)}°, expected ~23.44°`,
      );
    });

    it('nutation matrix is orthogonal', () => {
      const terms = computeNutationTerms(JD_VALLADO);
      const N = computeNutationMatrix(terms);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let dot = 0;
          for (let k = 0; k < 3; k++) dot += N[k][i] * N[k][j];
          const expected = i === j ? 1 : 0;
          assert.ok(
            Math.abs(dot - expected) < 1e-12,
            `N^T*N[${i}][${j}] = ${dot}, expected ${expected}`,
          );
        }
      }
    });
  });
});
