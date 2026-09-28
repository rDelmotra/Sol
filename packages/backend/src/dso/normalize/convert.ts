import { ER_KM } from '@orbitwatch/orbital-core';
import type { ProviderFetchResult } from '../providers/index.js';
import type { DsoRegistryEntry } from '../registry/index.js';
import type { DsoSnapshot } from '../snapshot/index.js';
import type { CanonicalStateVector } from './types.js';

const J2000_JULIAN_DAY = 2451545.0;
const JULIAN_DAYS_PER_CENTURY = 36525.0;
const SECONDS_PER_DAY = 86400;
const APPROX_TDB_MINUS_UTC_SECONDS = 69.184;
const CENTRAL_DIFFERENCE_SECONDS = 1.0;
const ARCSEC_TO_RAD = (Math.PI / 180) / 3600;
const DEG_TO_RAD = Math.PI / 180;

type Vector3 = [number, number, number];
type Matrix3 = [Vector3, Vector3, Vector3];

export class DsoNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsoNormalizationError';
  }
}

function toJulianDayUtc(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

function toApproxJulianDayTdbFromUtcDate(date: Date): number {
  return toJulianDayUtc(date) + APPROX_TDB_MINUS_UTC_SECONDS / SECONDS_PER_DAY;
}

function approxJulianDayTdbToIsoUtc(julianDayTdb: number): string {
  const epochMs = (julianDayTdb - 2440587.5) * 86400000;
  return new Date(epochMs - APPROX_TDB_MINUS_UTC_SECONDS * 1000).toISOString();
}

function toSnapshotVersion(isoTimestamp: string): string {
  return isoTimestamp.replace(/\.\d{3}Z$/, 'Z').replace(/:(\d{2})(?=Z)/g, '$1');
}

function secondsBetweenIso(startIso: string, endIso: string): number {
  return (Date.parse(endIso) - Date.parse(startIso)) / 1000;
}

function rotationX(angleRad: number): Matrix3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    [1, 0, 0],
    [0, c, s],
    [0, -s, c],
  ];
}

function rotationY(angleRad: number): Matrix3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    [c, 0, -s],
    [0, 1, 0],
    [s, 0, c],
  ];
}

function rotationZ(angleRad: number): Matrix3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1],
  ];
}

function multiplyMatrices(a: Matrix3, b: Matrix3): Matrix3 {
  const result: Matrix3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      result[row][col] =
        a[row][0] * b[0][col] +
        a[row][1] * b[1][col] +
        a[row][2] * b[2][col];
    }
  }

  return result;
}

function multiplyMatrixVector(matrix: Matrix3, vector: Vector3): Vector3 {
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
  ];
}

function subtractMatrices(a: Matrix3, b: Matrix3): Matrix3 {
  return [
    [a[0][0] - b[0][0], a[0][1] - b[0][1], a[0][2] - b[0][2]],
    [a[1][0] - b[1][0], a[1][1] - b[1][1], a[1][2] - b[1][2]],
    [a[2][0] - b[2][0], a[2][1] - b[2][1], a[2][2] - b[2][2]],
  ];
}

function scaleMatrix(matrix: Matrix3, scalar: number): Matrix3 {
  return [
    [matrix[0][0] * scalar, matrix[0][1] * scalar, matrix[0][2] * scalar],
    [matrix[1][0] * scalar, matrix[1][1] * scalar, matrix[1][2] * scalar],
    [matrix[2][0] * scalar, matrix[2][1] * scalar, matrix[2][2] * scalar],
  ];
}

function computePrecessionMatrix(julianDayTdb: number): Matrix3 {
  const t = (julianDayTdb - J2000_JULIAN_DAY) / JULIAN_DAYS_PER_CENTURY;

  const zeta =
    (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * ARCSEC_TO_RAD;
  const theta =
    (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * ARCSEC_TO_RAD;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * ARCSEC_TO_RAD;

  return multiplyMatrices(
    multiplyMatrices(rotationZ(z), rotationY(-theta)),
    rotationZ(zeta),
  );
}

function normalizeDegrees(angle: number): number {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

// 106-term IAU 1980 nutation series coefficients
// Format: [l, l', F, D, Om, sin_coeff, sin_coeff_t, cos_coeff, cos_coeff_t]
// Sine/Cosine coefficients are in units of 0.1 milliarcseconds.
const IAU_1980_NUTATION_TERMS = [
  [  0,  0,  0,  0,  1, -171996.0, -174.2,  92025.0,    8.9 ],
  [  0,  0,  0,  0,  2,    2062.0,    0.2,   -895.0,    0.5 ],
  [ -2,  0,  2,  0,  1,      46.0,    0.0,    -24.0,    0.0 ],
  [  2,  0, -2,  0,  0,      11.0,    0.0,      0.0,    0.0 ],
  [ -2,  0,  2,  0,  2,      -3.0,    0.0,      1.0,    0.0 ],
  [  1, -1,  0, -1,  0,      -3.0,    0.0,      0.0,    0.0 ],
  [  0, -2,  2, -2,  1,      -2.0,    0.0,      1.0,    0.0 ],
  [  2,  0, -2,  0,  1,       1.0,    0.0,      0.0,    0.0 ],
  [  0,  0,  2, -2,  2,  -13187.0,   -1.6,   5736.0,   -3.1 ],
  [  0,  1,  0,  0,  0,    1426.0,   -3.4,     54.0,   -0.1 ],
  [  0,  1,  2, -2,  2,    -517.0,    1.2,    224.0,   -0.6 ],
  [  0, -1,  2, -2,  2,     217.0,   -0.5,    -95.0,    0.3 ],
  [  0,  0,  2, -2,  1,     129.0,    0.1,    -70.0,    0.0 ],
  [  2,  0,  0, -2,  0,      48.0,    0.0,      1.0,    0.0 ],
  [  0,  0,  2, -2,  0,     -22.0,    0.0,      0.0,    0.0 ],
  [  0,  2,  0,  0,  0,      17.0,   -0.1,      0.0,    0.0 ],
  [  0,  1,  0,  0,  1,     -15.0,    0.0,      9.0,    0.0 ],
  [  0,  2,  2, -2,  2,     -16.0,    0.1,      7.0,    0.0 ],
  [  0, -1,  0,  0,  1,     -12.0,    0.0,      6.0,    0.0 ],
  [ -2,  0,  0,  2,  1,      -6.0,    0.0,      3.0,    0.0 ],
  [  0, -1,  2, -2,  1,      -5.0,    0.0,      3.0,    0.0 ],
  [  2,  0,  0, -2,  1,       4.0,    0.0,     -2.0,    0.0 ],
  [  0,  1,  2, -2,  1,       4.0,    0.0,     -2.0,    0.0 ],
  [  1,  0,  0, -1,  0,      -4.0,    0.0,      0.0,    0.0 ],
  [  2,  1,  0, -2,  0,       1.0,    0.0,      0.0,    0.0 ],
  [  0,  0, -2,  2,  1,       1.0,    0.0,      0.0,    0.0 ],
  [  0,  1, -2,  2,  0,      -1.0,    0.0,      0.0,    0.0 ],
  [  0,  1,  0,  0,  2,       1.0,    0.0,      0.0,    0.0 ],
  [ -1,  0,  0,  1,  1,       1.0,    0.0,      0.0,    0.0 ],
  [  0,  1,  2, -2,  0,      -1.0,    0.0,      0.0,    0.0 ],
  [  0,  0,  2,  0,  2,   -2274.0,   -0.2,    977.0,   -0.5 ],
  [  1,  0,  0,  0,  0,     712.0,    0.1,     -7.0,    0.0 ],
  [  0,  0,  2,  0,  1,    -386.0,   -0.4,    200.0,    0.0 ],
  [  1,  0,  2,  0,  2,    -301.0,    0.0,    129.0,   -0.1 ],
  [  1,  0,  0, -2,  0,    -158.0,    0.0,     -1.0,    0.0 ],
  [ -1,  0,  2,  0,  2,     123.0,    0.0,    -53.0,    0.0 ],
  [  0,  0,  0,  2,  0,      63.0,    0.0,     -2.0,    0.0 ],
  [  1,  0,  0,  0,  1,      63.0,    0.1,    -33.0,    0.0 ],
  [ -1,  0,  0,  0,  1,     -58.0,   -0.1,     32.0,    0.0 ],
  [ -1,  0,  2,  2,  2,     -59.0,    0.0,     26.0,    0.0 ],
  [  1,  0,  2,  0,  1,     -51.0,    0.0,     27.0,    0.0 ],
  [  0,  0,  2,  2,  2,     -38.0,    0.0,     16.0,    0.0 ],
  [  2,  0,  0,  0,  0,      29.0,    0.0,     -1.0,    0.0 ],
  [  1,  0,  2, -2,  2,      29.0,    0.0,    -12.0,    0.0 ],
  [  2,  0,  2,  0,  2,     -31.0,    0.0,     13.0,    0.0 ],
  [  0,  0,  2,  0,  0,      26.0,    0.0,     -1.0,    0.0 ],
  [ -1,  0,  2,  0,  1,      21.0,    0.0,    -10.0,    0.0 ],
  [ -1,  0,  0,  2,  1,      16.0,    0.0,     -8.0,    0.0 ],
  [  1,  0,  0, -2,  1,     -13.0,    0.0,      7.0,    0.0 ],
  [ -1,  0,  2,  2,  1,     -10.0,    0.0,      5.0,    0.0 ],
  [  1,  1,  0, -2,  0,      -7.0,    0.0,      0.0,    0.0 ],
  [  0,  1,  2,  0,  2,       7.0,    0.0,     -3.0,    0.0 ],
  [  0, -1,  2,  0,  2,      -7.0,    0.0,      3.0,    0.0 ],
  [  1,  0,  2,  2,  2,      -8.0,    0.0,      3.0,    0.0 ],
  [  1,  0,  0,  2,  0,       6.0,    0.0,      0.0,    0.0 ],
  [  2,  0,  2, -2,  2,       6.0,    0.0,     -3.0,    0.0 ],
  [  0,  0,  0,  2,  1,      -6.0,    0.0,      3.0,    0.0 ],
  [  0,  0,  2,  2,  1,      -7.0,    0.0,      3.0,    0.0 ],
  [  1,  0,  2, -2,  1,       6.0,    0.0,     -3.0,    0.0 ],
  [  0,  0,  0, -2,  1,      -5.0,    0.0,      3.0,    0.0 ],
  [  1, -1,  0,  0,  0,       5.0,    0.0,      0.0,    0.0 ],
  [  2,  0,  2,  0,  1,      -5.0,    0.0,      3.0,    0.0 ],
  [  0,  1,  0, -2,  0,      -4.0,    0.0,      0.0,    0.0 ],
  [  1,  0, -2,  0,  0,       4.0,    0.0,      0.0,    0.0 ],
  [  0,  0,  0,  1,  0,      -4.0,    0.0,      0.0,    0.0 ],
  [  1,  1,  0,  0,  0,      -3.0,    0.0,      0.0,    0.0 ],
  [  1,  0,  2,  0,  0,       3.0,    0.0,      0.0,    0.0 ],
  [  1, -1,  2,  0,  2,      -3.0,    0.0,      1.0,    0.0 ],
  [ -1, -1,  2,  2,  2,      -3.0,    0.0,      1.0,    0.0 ],
  [ -2,  0,  0,  0,  1,      -2.0,    0.0,      1.0,    0.0 ],
  [  3,  0,  2,  0,  2,      -3.0,    0.0,      1.0,    0.0 ],
  [  0, -1,  2,  2,  2,      -3.0,    0.0,      1.0,    0.0 ],
  [  1,  1,  2,  0,  2,       2.0,    0.0,     -1.0,    0.0 ],
  [ -1,  0,  2, -2,  1,      -2.0,    0.0,      1.0,    0.0 ],
  [  2,  0,  0,  0,  1,       2.0,    0.0,     -1.0,    0.0 ],
  [  1,  0,  0,  0,  2,      -2.0,    0.0,      1.0,    0.0 ],
  [  3,  0,  0,  0,  0,       2.0,    0.0,      0.0,    0.0 ],
  [  0,  0,  2,  1,  2,       2.0,    0.0,     -1.0,    0.0 ],
  [ -1,  0,  0,  0,  2,       1.0,    0.0,     -1.0,    0.0 ],
  [  1,  0,  0, -4,  0,      -1.0,    0.0,      0.0,    0.0 ],
  [ -2,  0,  2,  2,  2,       1.0,    0.0,     -1.0,    0.0 ],
  [ -1,  0,  2,  4,  2,      -2.0,    0.0,      1.0,    0.0 ],
  [  2,  0,  0, -4,  0,      -1.0,    0.0,      0.0,    0.0 ],
  [  1,  1,  2, -2,  2,       1.0,    0.0,     -1.0,    0.0 ],
  [  1,  0,  2,  2,  1,      -1.0,    0.0,      1.0,    0.0 ],
  [ -2,  0,  2,  4,  2,      -1.0,    0.0,      1.0,    0.0 ],
  [ -1,  0,  4,  0,  2,       1.0,    0.0,      0.0,    0.0 ],
  [  1, -1,  0, -2,  0,       1.0,    0.0,      0.0,    0.0 ],
  [  2,  0,  2, -2,  1,       1.0,    0.0,     -1.0,    0.0 ],
  [  2,  0,  2,  2,  2,      -1.0,    0.0,      0.0,    0.0 ],
  [  1,  0,  0,  2,  1,      -1.0,    0.0,      0.0,    0.0 ],
  [  0,  0,  4, -2,  2,       1.0,    0.0,      0.0,    0.0 ],
  [  3,  0,  2, -2,  2,       1.0,    0.0,      0.0,    0.0 ],
  [  1,  0,  2, -2,  0,      -1.0,    0.0,      0.0,    0.0 ],
  [  0,  1,  2,  0,  1,       1.0,    0.0,      0.0,    0.0 ],
  [ -1, -1,  0,  2,  1,       1.0,    0.0,      0.0,    0.0 ],
  [  0,  0, -2,  0,  1,      -1.0,    0.0,      0.0,    0.0 ],
  [  0,  0,  2, -1,  2,      -1.0,    0.0,      0.0,    0.0 ],
  [  0,  1,  0,  2,  0,      -1.0,    0.0,      0.0,    0.0 ],
  [  1,  0, -2, -2,  0,      -1.0,    0.0,      0.0,    0.0 ],
  [  0, -1,  2,  0,  1,      -1.0,    0.0,      0.0,    0.0 ],
  [  1,  1,  0, -2,  1,      -1.0,    0.0,      0.0,    0.0 ],
  [  1,  0, -2,  2,  0,      -1.0,    0.0,      0.0,    0.0 ],
  [  2,  0,  0,  2,  0,       1.0,    0.0,      0.0,    0.0 ],
  [  0,  0,  2,  4,  2,      -1.0,    0.0,      0.0,    0.0 ],
  [  0,  1,  0,  1,  0,       1.0,    0.0,      0.0,    0.0 ],
];

function normalizeAnglePmPi(a: number): number {
  const D2PI = Math.PI * 2;
  let w = a % D2PI;
  if (Math.abs(w) >= Math.PI) {
    w -= (w > 0) ? D2PI : -D2PI;
  }
  return w;
}

function computeNutationTerms(julianDayTdb: number): {
  deltaPsiRad: number;
  deltaEpsilonRad: number;
  meanObliquityRad: number;
  trueObliquityRad: number;
  equationOfEquinoxesRad: number;
} {
  const t = (julianDayTdb - J2000_JULIAN_DAY) / JULIAN_DAYS_PER_CENTURY;

  // Constants to convert arcsec to radians, etc.
  const ERFA_DAS2R = 4.848136811095359935899141e-6;
  const ERFA_D2PI = Math.PI * 2;

  // Form fundamental arguments in radians (IAU 1980)
  // l: Mean anomaly of the Moon
  const l = normalizeAnglePmPi((485866.733 + (715922.633 + (31.310 + 0.064 * t) * t) * t) * ERFA_DAS2R + ((1325.0 * t) % 1.0) * ERFA_D2PI);
  // l': Mean anomaly of the Sun
  const lp = normalizeAnglePmPi((1287099.804 + (1292581.224 + (-0.577 - 0.012 * t) * t) * t) * ERFA_DAS2R + ((99.0 * t) % 1.0) * ERFA_D2PI);
  // F: Mean longitude of the Moon minus mean longitude of Moon's node
  const f = normalizeAnglePmPi((335778.877 + (295263.137 + (-13.257 + 0.011 * t) * t) * t) * ERFA_DAS2R + ((1342.0 * t) % 1.0) * ERFA_D2PI);
  // D: Mean elongation of Moon from Sun
  const d = normalizeAnglePmPi((1072261.307 + (1105601.328 + (-6.891 + 0.019 * t) * t) * t) * ERFA_DAS2R + ((1236.0 * t) % 1.0) * ERFA_D2PI);
  // Om: Longitude of the mean ascending node of the lunar orbit on the ecliptic
  const om = normalizeAnglePmPi((450160.280 + (-482890.539 + (7.455 + 0.008 * t) * t) * t) * ERFA_DAS2R + ((-5.0 * t) % 1.0) * ERFA_D2PI);

  let dp = 0.0;
  let de = 0.0;

  // Sum the nutation terms, backwards starting with smallest
  for (let j = IAU_1980_NUTATION_TERMS.length - 1; j >= 0; j--) {
    const term = IAU_1980_NUTATION_TERMS[j];
    const arg = term[0] * l + term[1] * lp + term[2] * f + term[3] * d + term[4] * om;
    
    const s = term[5] + term[6] * t;
    const c = term[7] + term[8] * t;
    
    if (s !== 0.0) dp += s * Math.sin(arg);
    if (c !== 0.0) de += c * Math.cos(arg);
  }

  // Convert results from 0.1 mas units to radians
  const U2R = ERFA_DAS2R / 10000;
  const deltaPsiRad = dp * U2R;
  const deltaEpsilonRad = de * U2R;

  // Mean obliquity of the ecliptic (IAU 1976/1980)
  const meanObliquityArcsec = 84381.448 - 46.815 * t - 0.00059 * t * t + 0.001813 * t * t * t;
  const meanObliquityRad = meanObliquityArcsec * ARCSEC_TO_RAD;

  const trueObliquityRad = meanObliquityRad + deltaEpsilonRad;

  // Equation of equinoxes
  const equationOfEquinoxesRad = deltaPsiRad * Math.cos(trueObliquityRad);

  return {
    deltaPsiRad,
    deltaEpsilonRad,
    meanObliquityRad,
    trueObliquityRad,
    equationOfEquinoxesRad,
  };
}

function computeNutationMatrix(nutationTerms: {
  deltaPsiRad: number;
  meanObliquityRad: number;
  trueObliquityRad: number;
}): Matrix3 {
  const { deltaPsiRad, meanObliquityRad, trueObliquityRad } = nutationTerms;

  return multiplyMatrices(
    multiplyMatrices(rotationX(-trueObliquityRad), rotationZ(-deltaPsiRad)),
    rotationX(meanObliquityRad),
  );
}

function computeJ2000ToTemeMatrix(julianDayTdb: number): Matrix3 {
  const precession = computePrecessionMatrix(julianDayTdb);
  const nutationTerms = computeNutationTerms(julianDayTdb);
  const nutation = computeNutationMatrix(nutationTerms);
  const { equationOfEquinoxesRad } = nutationTerms;

  return multiplyMatrices(
    rotationZ(-equationOfEquinoxesRad),
    multiplyMatrices(nutation, precession),
  );
}

function computeJ2000ToTemeMatrixDerivative(julianDayTdb: number): Matrix3 {
  const deltaDays = CENTRAL_DIFFERENCE_SECONDS / SECONDS_PER_DAY;
  const ahead = computeJ2000ToTemeMatrix(julianDayTdb + deltaDays);
  const behind = computeJ2000ToTemeMatrix(julianDayTdb - deltaDays);
  return scaleMatrix(subtractMatrices(ahead, behind), 1 / (2 * CENTRAL_DIFFERENCE_SECONDS));
}

function convertSampleToTemeState(sample: ProviderFetchResult['samples'][number]): CanonicalStateVector {
  const positionJ2000: Vector3 = [sample.x, sample.y, sample.z];
  const velocityJ2000: Vector3 = [sample.vx, sample.vy, sample.vz];

  const rotation = computeJ2000ToTemeMatrix(sample.julianDayTdb);
  const rotationDerivative = computeJ2000ToTemeMatrixDerivative(sample.julianDayTdb);

  const positionTemeKm = multiplyMatrixVector(rotation, positionJ2000);
  const velocityRotatedKmPerSec = multiplyMatrixVector(rotation, velocityJ2000);
  const velocityFrameTermKmPerSec = multiplyMatrixVector(rotationDerivative, positionJ2000);

  const velocityTemeKmPerSec: Vector3 = [
    velocityRotatedKmPerSec[0] + velocityFrameTermKmPerSec[0],
    velocityRotatedKmPerSec[1] + velocityFrameTermKmPerSec[1],
    velocityRotatedKmPerSec[2] + velocityFrameTermKmPerSec[2],
  ];

  return [
    approxJulianDayTdbToIsoUtc(sample.julianDayTdb),
    positionTemeKm[0] / ER_KM,
    positionTemeKm[1] / ER_KM,
    positionTemeKm[2] / ER_KM,
    velocityTemeKmPerSec[0] / ER_KM,
    velocityTemeKmPerSec[1] / ER_KM,
    velocityTemeKmPerSec[2] / ER_KM,
  ];
}

export function convertProviderFetchToDsoSnapshot(
  entry: DsoRegistryEntry,
  providerFetch: ProviderFetchResult,
  windowStart: Date,
  windowEnd: Date,
): DsoSnapshot {
  if (providerFetch.samples.length === 0) {
    throw new DsoNormalizationError(`Provider fetch for ${entry.dsoId} returned no samples`);
  }

  const windowStartJdTdb = toApproxJulianDayTdbFromUtcDate(windowStart);
  const windowEndJdTdb = toApproxJulianDayTdbFromUtcDate(windowEnd);

  if (windowEndJdTdb <= windowStartJdTdb) {
    throw new DsoNormalizationError('Normalization window end must be after start');
  }

  const sortedSamples = [...providerFetch.samples].sort(
    (left, right) => left.julianDayTdb - right.julianDayTdb,
  );

  for (let index = 1; index < sortedSamples.length; index++) {
    if (sortedSamples[index].julianDayTdb <= sortedSamples[index - 1].julianDayTdb) {
      throw new DsoNormalizationError(`Provider samples for ${entry.dsoId} are not strictly ascending`);
    }
  }

  const clippedSamples = sortedSamples.filter(
    (sample) => sample.julianDayTdb >= windowStartJdTdb && sample.julianDayTdb <= windowEndJdTdb,
  );

  if (clippedSamples.length === 0) {
    throw new DsoNormalizationError(
      `No provider samples for ${entry.dsoId} fall within the requested validity window`,
    );
  }

  const stateVectors = clippedSamples.map(convertSampleToTemeState);
  const validFrom = stateVectors[0][0];
  const validTo = stateVectors[stateVectors.length - 1][0];
  const snapshotVersion = toSnapshotVersion(providerFetch.fetchedAt);

  if (secondsBetweenIso(validFrom, validTo) <= 0) {
    throw new DsoNormalizationError(`Normalized validity window for ${entry.dsoId} is not positive`);
  }

  return {
    dsoId: entry.dsoId,
    snapshotVersion,
    provider: providerFetch.provider,
    sourceObjectId: providerFetch.providerObjectId,
    sourceFrame: providerFetch.sourceFrame,
    frame: 'TEME',
    distanceUnits: 'earth_radii',
    velocityUnits: 'earth_radii_per_second',
    sampleStepSec: entry.sampleStepSec,
    fetchedAt: providerFetch.fetchedAt,
    sourceRevisionAt: providerFetch.sourceRevisionAt,
    validFrom,
    validTo,
    freshnessState: 'fresh',
    stateVectors,
  };
}

/**
 * Internal functions exposed exclusively for golden-vector regression testing.
 * Do NOT use in production code paths.
 */
export const __testing__ = {
  computePrecessionMatrix,
  computeNutationTerms,
  computeNutationMatrix,
  computeJ2000ToTemeMatrix,
  computeJ2000ToTemeMatrixDerivative,
  convertSampleToTemeState,
  convertProviderFetchToDsoSnapshot,
  multiplyMatrixVector,
  approxJulianDayTdbToIsoUtc,
  EARTH_RADIUS_KM: ER_KM,
  J2000_JULIAN_DAY,
} as const;
