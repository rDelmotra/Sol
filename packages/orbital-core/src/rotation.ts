// ============================================================
// Rotation — ECEF ⇄ TEME (Earth-fixed ⇄ inertial-of-date), about the polar
// (z) axis by a sidereal angle θ (typically gmst(tMs)).
//
// EXACT current sum order preserved:
//   - ecefToTeme matches the former observerTeme / getObserverScenePosition
//     ECEF→ECI step (those copies are now removed).
//   - temeToEcef matches the latDeg/lonDeg field case in
//     query/analytic/live-source.ts and backend analytic/providers/sgp4.ts.
// (Caching cos(theta)/sin(theta) once instead of recomputing per component is
// arithmetically identical — same two Math.cos/Math.sin calls, just reused.)
// ============================================================

import type { Vec3 } from './vec.js';

/** ECEF → TEME: rotate by +θ about the polar axis. */
export function ecefToTeme(v: Vec3, theta: number): Vec3 {
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  return {
    x: v.x * cosT - v.y * sinT,
    y: v.x * sinT + v.y * cosT,
    z: v.z,
  };
}

/** TEME → ECEF: rotate by −θ about the polar axis (the inverse of ecefToTeme). */
export function temeToEcef(v: Vec3, theta: number): Vec3 {
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  return {
    x: cosT * v.x + sinT * v.y,
    y: -sinT * v.x + cosT * v.y,
    z: v.z,
  };
}
