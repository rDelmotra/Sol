// ============================================================
// Frames — TEME-of-date <-> J2000 / GCRF.
//
// SGP4 outputs positions in TEME (True Equator, Mean Equinox of DATE): a frame that rotates slowly with precession and nutation, so
// two star-map cells from different dates are NOT in the same frame. This module converts between TEME of a date and the fixed
// J2000 frame (GCRF to within the FK5 frame bias, ~20 mas = about 0.7 m at 7000 km), with the classical chain Vallado uses for TEME
// (Vallado, Crawford, Hujsak & Kelso 2006, "Revisiting Spacetrack Report #3", AIAA 2006-6753; Vallado, Fundamentals of
// Astrodynamics and Applications, 4th ed., sec. 3.7):
//
//     TEME --R3(-Eq)--> TOD --N^T--> MOD --P^T--> J2000
//       Eq   = dpsi * cos(eps_mean)                    equation of the equinoxes (the kinematic terms 0.00264" sin(Om) + ... are not
//                                                      part of the TEME definition and are below 0.1 m; not applied)
//       N    = R1(-eps) R3(dpsi) R1(eps_mean)          IAU-80 nutation (106-term series; no celestial pole offsets, ddpsi = ddeps = 0)
//       P    = R3(-z) R2(theta) R3(-zeta)  (J2000 -> MOD)  IAU-76 precession
//
// NOT WIRED INTO THE BUILD. The star-map coverage lists and every per-day file stay in TEME of their own day (one SGP4 pass, no frame
// work at build time). Use rotateBetweenDates() only when comparing cells / vectors of different days: rotate one into the
// frame of the other first. Time argument is UTC milliseconds; TT-UTC comes from the leap-second table below (the effect of a few
// seconds of error is far below the model: precession moves 50"/yr, nutation changes by <1 mas in a minute).
//
// Nutation series: IAU 1980 theory of nutation (Wahr; Seidelmann 1982), 106 terms, as tabulated in the IERS Conventions 1996 /
// SOFA-ERFA nut80 (coefficients in 0.1 mas; sin terms for dpsi, cos terms for deps, each as a + b*T).
// ============================================================

import type { Vec3 } from './vec.js';

const ARCSEC = Math.PI / 648000;
const TWO_PI = 2 * Math.PI;
const DAS2R = ARCSEC;

/** 3x3 matrix, row-major. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** UTC instants (ms) from which TAI-UTC takes the given value in seconds (1972 onwards). */
const LEAP: ReadonlyArray<readonly [number, number]> = [
  [Date.UTC(1972, 0, 1), 10], [Date.UTC(1972, 6, 1), 11], [Date.UTC(1973, 0, 1), 12], [Date.UTC(1974, 0, 1), 13], [Date.UTC(1975, 0, 1), 14],
  [Date.UTC(1976, 0, 1), 15], [Date.UTC(1977, 0, 1), 16], [Date.UTC(1978, 0, 1), 17], [Date.UTC(1979, 0, 1), 18], [Date.UTC(1980, 0, 1), 19],
  [Date.UTC(1981, 6, 1), 20], [Date.UTC(1982, 6, 1), 21], [Date.UTC(1983, 6, 1), 22], [Date.UTC(1985, 6, 1), 23], [Date.UTC(1988, 0, 1), 24],
  [Date.UTC(1990, 0, 1), 25], [Date.UTC(1991, 0, 1), 26], [Date.UTC(1992, 6, 1), 27], [Date.UTC(1993, 6, 1), 28], [Date.UTC(1994, 6, 1), 29],
  [Date.UTC(1996, 0, 1), 30], [Date.UTC(1997, 6, 1), 31], [Date.UTC(1999, 0, 1), 32], [Date.UTC(2006, 0, 1), 33], [Date.UTC(2009, 0, 1), 34],
  [Date.UTC(2012, 6, 1), 35], [Date.UTC(2015, 6, 1), 36], [Date.UTC(2017, 0, 1), 37],
];

/**
 * TT - UTC in seconds: 32.184 + (TAI - UTC). Before 1972 UTC had no leap seconds (rubber seconds); 10 s is used there as a
 * constant (TAI-UTC was 1.4 to 4.2 s; an error of 8 s is irrelevant to the frame, see the header).
 */
export function ttMinusUtcSeconds(tMs: number): number {
  let d = 10;
  for (const [t, s] of LEAP) if (tMs >= t) d = s;
  return 32.184 + d;
}

/** Julian centuries of TT since J2000.0 for a UTC millisecond timestamp. */
export function centuriesTT(tMs: number): number {
  const jdUtc = tMs / 86400000.0 + 2440587.5;
  const jdTt = jdUtc + ttMinusUtcSeconds(tMs) / 86400;
  return (jdTt - 2451545.0) / 36525.0;
}

// ---------------- elementary rotations (passive: they rotate the coordinate axes, Vallado's ROTn) ----------------
const rot1 = (a: number): Mat3 => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c]; };
const rot2 = (a: number): Mat3 => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; };
const rot3 = (a: number): Mat3 => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1]; };

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = a[3 * i]! * b[j]! + a[3 * i + 1]! * b[3 + j]! + a[3 * i + 2]! * b[6 + j]!;
  return o as unknown as Mat3;
}
export function matTranspose(a: Mat3): Mat3 { return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]; }
export function matApply(m: Mat3, v: Vec3): Vec3 {
  return { x: m[0] * v.x + m[1] * v.y + m[2] * v.z, y: m[3] * v.x + m[4] * v.y + m[5] * v.z, z: m[6] * v.x + m[7] * v.y + m[8] * v.z };
}

// ---------------- precession (IAU 1976) ----------------
/** Precession angles zeta, theta, z (radians) from J2000 to the mean equator / equinox of date, T in Julian centuries TT. */
export function precessionAngles(T: number): { zeta: number; theta: number; z: number } {
  return {
    zeta: (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ARCSEC,
    theta: (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ARCSEC,
    z: (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ARCSEC,
  };
}
/** J2000 -> MOD (mean of date). */
export function precessionMatrix(T: number): Mat3 {
  const { zeta, theta, z } = precessionAngles(T);
  return matMul(matMul(rot3(-z), rot2(theta)), rot3(-zeta));
}

// ---------------- nutation (IAU 1980) ----------------
/** Mean obliquity of the ecliptic, IAU 1976 (radians). */
export function meanObliquity(T: number): number {
  return (84381.448 - 46.8150 * T - 0.00059 * T * T + 0.001813 * T * T * T) * ARCSEC;
}

/** Normalise to (-pi, pi]. */
const anpm = (a: number): number => { const w = a % TWO_PI; return Math.abs(w) >= Math.PI ? w - Math.sign(a) * TWO_PI : w; };

/** Delaunay arguments l, l', F, D, Omega (radians) at T (IAU 1980 / 1996 conventions). */
export function delaunay(T: number): [number, number, number, number, number] {
  return [
    anpm((485866.733 + (715922.633 + (31.310 + 0.064 * T) * T) * T) * DAS2R + ((1325.0 * T) % 1) * TWO_PI),
    anpm((1287099.804 + (1292581.224 + (-0.577 - 0.012 * T) * T) * T) * DAS2R + ((99.0 * T) % 1) * TWO_PI),
    anpm((335778.877 + (295263.137 + (-13.257 + 0.011 * T) * T) * T) * DAS2R + ((1342.0 * T) % 1) * TWO_PI),
    anpm((1072261.307 + (1105601.328 + (-6.891 + 0.019 * T) * T) * T) * DAS2R + ((1236.0 * T) % 1) * TWO_PI),
    anpm((450160.280 + (-482890.539 + (7.455 + 0.008 * T) * T) * T) * DAS2R + ((-5.0 * T) % 1) * TWO_PI),
  ];
}

/** Nutation in longitude and obliquity (radians), IAU 1980, no celestial pole offsets. */
export function nutation80(T: number): { dpsi: number; deps: number } {
  const [el, elp, f, d, om] = delaunay(T);
  let dp = 0, de = 0;
  for (let j = NUT80.length - 1; j >= 0; j--) {
    const r = NUT80[j]!;
    const arg = r[0] * el + r[1] * elp + r[2] * f + r[3] * d + r[4] * om;
    dp += (r[5] + r[6] * T) * Math.sin(arg);
    de += (r[7] + r[8] * T) * Math.cos(arg);
  }
  const U2R = DAS2R / 1e4; // 0.1 mas -> rad
  return { dpsi: dp * U2R, deps: de * U2R };
}

/** MOD -> TOD (true of date): N = R1(-eps) R3(dpsi) R1(eps_mean) applied to a MOD vector. */
export function nutationMatrix(T: number): { n: Mat3; dpsi: number; deps: number; epsMean: number } {
  const epsMean = meanObliquity(T);
  const { dpsi, deps } = nutation80(T);
  const eps = epsMean + deps;
  return { n: matMul(matMul(rot1(-eps), rot3(-dpsi)), rot1(epsMean)), dpsi, deps, epsMean };
}

// ---------------- the TEME chain ----------------
/** Rotation TEME(t) -> J2000 as a matrix (v_J2000 = M v_TEME). */
export function temeToJ2000Matrix(tMs: number): Mat3 {
  const T = centuriesTT(tMs);
  const { n, dpsi, epsMean } = nutationMatrix(T);
  const eq = dpsi * Math.cos(epsMean);
  // J2000 -> MOD (P) -> TOD (N) -> TEME (R3(eq)); TEME -> J2000 is the transpose of that product
  return matTranspose(matMul(rot3(eq), matMul(n, precessionMatrix(T))));
}

/** TEME of the date `tMs` -> J2000 / GCRF. */
export function temeToJ2000(v: Vec3, tMs: number): Vec3 { return matApply(temeToJ2000Matrix(tMs), v); }
/** J2000 / GCRF -> TEME of the date `tMs`. */
export function j2000ToTeme(v: Vec3, tMs: number): Vec3 { return matApply(matTranspose(temeToJ2000Matrix(tMs)), v); }

/**
 * A TEME vector of date `fromMs` expressed in the TEME frame of date `toMs` (through J2000). Use it to compare star-map cells or
 * positions computed on different days. For vectors of one day no rotation is needed.
 */
export function rotateBetweenDates(vecTeme: Vec3, fromMs: number, toMs: number): Vec3 {
  if (fromMs === toMs) return { x: vecTeme.x, y: vecTeme.y, z: vecTeme.z };
  return j2000ToTeme(temeToJ2000(vecTeme, fromMs), toMs);
}

/** The 106 terms of the IAU 1980 nutation series: [l, l', F, D, Omega, sin dpsi a, sin dpsi b (per T), cos deps a, cos deps b (per T)], units 0.1 mas. */
const NUT80: ReadonlyArray<readonly [number, number, number, number, number, number, number, number, number]> = [
  [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
  [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
  [-2, 0, 2, 0, 1, 46, 0, -24, 0],
  [2, 0, -2, 0, 0, 11, 0, 0, 0],
  [-2, 0, 2, 0, 2, -3, 0, 1, 0],
  [1, -1, 0, -1, 0, -3, 0, 0, 0],
  [0, -2, 2, -2, 1, -2, 0, 1, 0],
  [2, 0, -2, 0, 1, 1, 0, 0, 0],
  [0, 0, 2, -2, 2, -13187, -1.6, 5736, -3.1],
  [0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
  [0, 1, 2, -2, 2, -517, 1.2, 224, -0.6],
  [0, -1, 2, -2, 2, 217, -0.5, -95, 0.3],
  [0, 0, 2, -2, 1, 129, 0.1, -70, 0],
  [2, 0, 0, -2, 0, 48, 0, 1, 0],
  [0, 0, 2, -2, 0, -22, 0, 0, 0],
  [0, 2, 0, 0, 0, 17, -0.1, 0, 0],
  [0, 1, 0, 0, 1, -15, 0, 9, 0],
  [0, 2, 2, -2, 2, -16, 0.1, 7, 0],
  [0, -1, 0, 0, 1, -12, 0, 6, 0],
  [-2, 0, 0, 2, 1, -6, 0, 3, 0],
  [0, -1, 2, -2, 1, -5, 0, 3, 0],
  [2, 0, 0, -2, 1, 4, 0, -2, 0],
  [0, 1, 2, -2, 1, 4, 0, -2, 0],
  [1, 0, 0, -1, 0, -4, 0, 0, 0],
  [2, 1, 0, -2, 0, 1, 0, 0, 0],
  [0, 0, -2, 2, 1, 1, 0, 0, 0],
  [0, 1, -2, 2, 0, -1, 0, 0, 0],
  [0, 1, 0, 0, 2, 1, 0, 0, 0],
  [-1, 0, 0, 1, 1, 1, 0, 0, 0],
  [0, 1, 2, -2, 0, -1, 0, 0, 0],
  [0, 0, 2, 0, 2, -2274, -0.2, 977, -0.5],
  [1, 0, 0, 0, 0, 712, 0.1, -7, 0],
  [0, 0, 2, 0, 1, -386, -0.4, 200, 0],
  [1, 0, 2, 0, 2, -301, 0, 129, -0.1],
  [1, 0, 0, -2, 0, -158, 0, -1, 0],
  [-1, 0, 2, 0, 2, 123, 0, -53, 0],
  [0, 0, 0, 2, 0, 63, 0, -2, 0],
  [1, 0, 0, 0, 1, 63, 0.1, -33, 0],
  [-1, 0, 0, 0, 1, -58, -0.1, 32, 0],
  [-1, 0, 2, 2, 2, -59, 0, 26, 0],
  [1, 0, 2, 0, 1, -51, 0, 27, 0],
  [0, 0, 2, 2, 2, -38, 0, 16, 0],
  [2, 0, 0, 0, 0, 29, 0, -1, 0],
  [1, 0, 2, -2, 2, 29, 0, -12, 0],
  [2, 0, 2, 0, 2, -31, 0, 13, 0],
  [0, 0, 2, 0, 0, 26, 0, -1, 0],
  [-1, 0, 2, 0, 1, 21, 0, -10, 0],
  [-1, 0, 0, 2, 1, 16, 0, -8, 0],
  [1, 0, 0, -2, 1, -13, 0, 7, 0],
  [-1, 0, 2, 2, 1, -10, 0, 5, 0],
  [1, 1, 0, -2, 0, -7, 0, 0, 0],
  [0, 1, 2, 0, 2, 7, 0, -3, 0],
  [0, -1, 2, 0, 2, -7, 0, 3, 0],
  [1, 0, 2, 2, 2, -8, 0, 3, 0],
  [1, 0, 0, 2, 0, 6, 0, 0, 0],
  [2, 0, 2, -2, 2, 6, 0, -3, 0],
  [0, 0, 0, 2, 1, -6, 0, 3, 0],
  [0, 0, 2, 2, 1, -7, 0, 3, 0],
  [1, 0, 2, -2, 1, 6, 0, -3, 0],
  [0, 0, 0, -2, 1, -5, 0, 3, 0],
  [1, -1, 0, 0, 0, 5, 0, 0, 0],
  [2, 0, 2, 0, 1, -5, 0, 3, 0],
  [0, 1, 0, -2, 0, -4, 0, 0, 0],
  [1, 0, -2, 0, 0, 4, 0, 0, 0],
  [0, 0, 0, 1, 0, -4, 0, 0, 0],
  [1, 1, 0, 0, 0, -3, 0, 0, 0],
  [1, 0, 2, 0, 0, 3, 0, 0, 0],
  [1, -1, 2, 0, 2, -3, 0, 1, 0],
  [-1, -1, 2, 2, 2, -3, 0, 1, 0],
  [-2, 0, 0, 0, 1, -2, 0, 1, 0],
  [3, 0, 2, 0, 2, -3, 0, 1, 0],
  [0, -1, 2, 2, 2, -3, 0, 1, 0],
  [1, 1, 2, 0, 2, 2, 0, -1, 0],
  [-1, 0, 2, -2, 1, -2, 0, 1, 0],
  [2, 0, 0, 0, 1, 2, 0, -1, 0],
  [1, 0, 0, 0, 2, -2, 0, 1, 0],
  [3, 0, 0, 0, 0, 2, 0, 0, 0],
  [0, 0, 2, 1, 2, 2, 0, -1, 0],
  [-1, 0, 0, 0, 2, 1, 0, -1, 0],
  [1, 0, 0, -4, 0, -1, 0, 0, 0],
  [-2, 0, 2, 2, 2, 1, 0, -1, 0],
  [-1, 0, 2, 4, 2, -2, 0, 1, 0],
  [2, 0, 0, -4, 0, -1, 0, 0, 0],
  [1, 1, 2, -2, 2, 1, 0, -1, 0],
  [1, 0, 2, 2, 1, -1, 0, 1, 0],
  [-2, 0, 2, 4, 2, -1, 0, 1, 0],
  [-1, 0, 4, 0, 2, 1, 0, 0, 0],
  [1, -1, 0, -2, 0, 1, 0, 0, 0],
  [2, 0, 2, -2, 1, 1, 0, -1, 0],
  [2, 0, 2, 2, 2, -1, 0, 0, 0],
  [1, 0, 0, 2, 1, -1, 0, 0, 0],
  [0, 0, 4, -2, 2, 1, 0, 0, 0],
  [3, 0, 2, -2, 2, 1, 0, 0, 0],
  [1, 0, 2, -2, 0, -1, 0, 0, 0],
  [0, 1, 2, 0, 1, 1, 0, 0, 0],
  [-1, -1, 0, 2, 1, 1, 0, 0, 0],
  [0, 0, -2, 0, 1, -1, 0, 0, 0],
  [0, 0, 2, -1, 2, -1, 0, 0, 0],
  [0, 1, 0, 2, 0, -1, 0, 0, 0],
  [1, 0, -2, -2, 0, -1, 0, 0, 0],
  [0, -1, 2, 0, 1, -1, 0, 0, 0],
  [1, 1, 0, -2, 1, -1, 0, 0, 0],
  [1, 0, -2, 2, 0, -1, 0, 0, 0],
  [2, 0, 0, 2, 0, 1, 0, 0, 0],
  [0, 0, 2, 4, 2, -1, 0, 0, 0],
  [0, 1, 0, 1, 0, 1, 0, 0, 0],
];
