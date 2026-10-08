// P2.2 O6 — retire the self-referential golden fixture.
//
// The old version of this file compared gmst/sunDirection/observerTeme
// against __fixtures__/astro-golden.json, a JSON snapshot generated FROM
// this same code's pre-orbital-core predecessor (gen-astro-golden.ts →
// astro.ts). That only proves "the new code equals the old copy of the new
// code" — it can't catch a bug both copies share, and it can't catch drift
// introduced when the fixture was generated. It has no connection to an
// independent, external notion of "correct".
//
// This file replaces that with three kinds of check that DO have an
// external anchor:
//
//   (a) Textbook reference values — Jean Meeus, "Astronomical Algorithms",
//       2nd ed. (Willmann-Bell, 1998). Every expected number below is
//       copied from the book examples named in each test; none are derived
//       or invented.
//   (b) Physical invariants (unit vectors, radii, rotation period) that
//       must hold regardless of which implementation computes them.
//   (c) Three literal "pre-refactor pin" rows copied verbatim from the
//       retired fixture, so a future refactor (e.g. phase 3's WGS84 switch)
//       has to touch these numbers ON PURPOSE rather than silently drift.
//
// __fixtures__/astro-golden.json itself has been moved to
// DELETE/packages/orbital-core/src/__fixtures__/astro-golden.json (it is no
// longer read by any test).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gmst } from './time.js';
import { sunDirection } from './sun.js';
import { observerTeme } from './observer.js';
import { DEG } from './units.js';

function assertCloseRel(actual: number, expected: number, msg: string, relTol = 1e-9): void {
  const diff = Math.abs(actual - expected);
  // Near-zero expected values (e.g. z=0 at the equator) need an absolute floor —
  // a pure relative tolerance is meaningless against zero.
  const tol = Math.max(relTol, relTol * Math.abs(expected));
  assert.ok(diff <= tol, `${msg}: expected ${expected}, got ${actual} (diff ${diff}, tol ${tol})`);
}

function assertCloseDeg(actualDeg: number, expectedDeg: number, msg: string, tolDeg: number): void {
  const diff = Math.abs(actualDeg - expectedDeg);
  assert.ok(diff <= tolDeg, `${msg}: expected ${expectedDeg}°, got ${actualDeg}° (diff ${diff}°, tol ${tolDeg}°)`);
}

// ------------------------------------------------------------------
// (a) External references — Meeus, Astronomical Algorithms, 2nd ed.
// ------------------------------------------------------------------

describe('gmst — Meeus GMST reference values', () => {
  it('Example 12.a: 1987 April 10, 0h UT → GMST = 13h10m46.3668s = 197.693195°', () => {
    const tMs = Date.parse('1987-04-10T00:00:00Z');
    const actualDeg = gmst(tMs) * DEG;
    assertCloseDeg(actualDeg, 197.693195, 'gmst Ex 12.a', 1e-6);
  });

  it('Example 12.b: 1987 April 10, 19h21m00s UT → GMST = 128.7378734°', () => {
    const tMs = Date.parse('1987-04-10T19:21:00Z');
    const actualDeg = gmst(tMs) * DEG;
    assertCloseDeg(actualDeg, 128.7378734, 'gmst Ex 12.b', 1e-6);
  });

  it('GMST at J2000.0 (2000-01-01T12:00:00Z) = 280.46061837° (same anchor time.test.ts checks; kept here to keep the three Meeus/J2000 GMST references together)', () => {
    const tMs = Date.parse('2000-01-01T12:00:00Z');
    const actualDeg = gmst(tMs) * DEG;
    assertCloseDeg(actualDeg, 280.46061837, 'gmst at J2000.0', 1e-6);
  });
});

describe('sunDirection — Meeus Example 25.a (1992 October 13, 0h TD)', () => {
  it('direction matches the book\'s TRUE solar longitude, to ~0.01°', () => {
    // Meeus Ex 25.a (low-accuracy method) gives, at 0h Dynamical Time:
    //   TRUE longitude ☉ = 199.90988°   (= L0 + C — what sunDirection() computes)
    //   apparent λ       = 199.90895°   (adds nutation + aberration — we do NOT)
    //   MEAN obliquity ε0 = 23.44023°   (what sunDirection() uses; true ε = 23.43999°)
    // So the like-for-like reference for our mean model is the TRUE longitude
    // with the MEAN obliquity. Do not "correct" these to the apparent values.
    // We evaluate at UT rather than TD (~1 minute apart in 1992), hence the
    // looser ~0.01° tolerance instead of the ~1e-6° used for GMST above.
    //
    // We derive the ecliptic longitude λ back out of the returned equatorial
    // unit vector (with the book's ε0) and compare that single angle, which
    // isolates "where does the sun point" from any obliquity rounding.
    const tMs = Date.parse('1992-10-13T00:00:00Z');
    const s = sunDirection(tMs);

    const epsBookRad = 23.44023 * (Math.PI / 180);
    const lambdaRad = Math.atan2(
      s.y * Math.cos(epsBookRad) + s.z * Math.sin(epsBookRad),
      s.x,
    );
    const lambdaDeg = (((lambdaRad * DEG) % 360) + 360) % 360;

    assertCloseDeg(lambdaDeg, 199.90988, 'sun true longitude Ex 25.a', 0.01);
  });
});

// ------------------------------------------------------------------
// (b) Physical invariants.
//
// |observerTeme(g,t).up| = 1 and WGS84 |position|
// are already exercised for both observerEcef and observerTeme in
// observer.test.ts, and for geodeticToEcefEr/geodeticUpEcef in
// earth.test.ts — not repeated here. Only the sidereal-rotation-period
// invariant (not covered elsewhere) is added below.
// ------------------------------------------------------------------

describe('gmst — rotation period invariant', () => {
  it('advances by ~2π every sidereal day (86164.0905 s), i.e. gmst is periodic with that period', () => {
    const siderealDayMs = 86164.0905 * 1000;
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const g0 = gmst(t0);
    const g1 = gmst(t0 + siderealDayMs);

    // g1 should equal g0 modulo 2π (one full sidereal rotation later, the
    // Earth is back to the same orientation relative to the stars).
    const twoPi = 2 * Math.PI;
    let diff = (g1 - g0) % twoPi;
    if (diff > Math.PI) diff -= twoPi;
    if (diff < -Math.PI) diff += twoPi;

    assert.ok(Math.abs(diff) < 1e-6, `gmst(t0+siderealDay) - gmst(t0) mod 2π = ${diff} rad, expected ~0`);
  });
});

// ------------------------------------------------------------------
// (c) Pre-refactor pin rows.
//
// These 3 rows are copied VERBATIM (tMs, gast, sun vector, one observer TEME
// position each) from the retired __fixtures__/astro-golden.json — see
// DELETE/packages/orbital-core/src/__fixtures__/astro-golden.json for the
// full original fixture. gmst/sun rows are the original pins (independent of
// the Earth's figure; if one moves, that's a real regression).
//
// WGS84 (S4b, 2026-10-09): the 3 observer rows were RE-PINNED to the ellipsoid.
// Independent derivation (/tmp/s4b/ref.py, pure python): reduced-latitude
// parametric forward (tanβ=(1-f)tanφ; ρ=a cosβ+h cosφ; z=b sinβ+h sinφ; a=6378.137,
// 1/f=298.257223563), / 6371 km per ER, then rotated about z by the pinned gmst of
// that row (ecef->TEME = +theta). Method sanity-checked by reproducing the old
// spherical London row to 1e-16.
// ------------------------------------------------------------------

describe('pre-refactor pin rows (gmst/sun pinned 2026-09-28; observer rows WGS84, re-pinned 2026-10-09)', () => {
  it('2026-01-01T00:00:00Z', () => {
    const tMs = 1767225600000;
    assertCloseRel(gmst(tMs), 1.7568634098762705, 'gmst');

    const s = sunDirection(tMs);
    assertCloseRel(s.x, 0.1835049166954881, 'sun.x');
    assertCloseRel(s.y, -0.9019251814789572, 'sun.y');
    assertCloseRel(s.z, -0.39096919643717776, 'sun.z');

    // Observer: London (51.5074, -0.1278, alt 0 km).
    const p = observerTeme({ latDeg: 51.5074, lonDeg: -0.1278, altKm: 0 }, tMs).position;
    assertCloseRel(p.x, -0.11414069341913727, 'observer.x');
    assertCloseRel(p.y, 0.6138711659415084, 'observer.y');
    assertCloseRel(p.z, 0.7799207247319123, 'observer.z');
  });

  it('2026-06-21T00:00:00Z (June solstice)', () => {
    const tMs = 1782000000000;
    assertCloseRel(gmst(tMs), 4.698540825230141, 'gmst');

    const s = sunDirection(tMs);
    assertCloseRel(s.x, 0.0057288724840353035, 'sun.x');
    assertCloseRel(s.y, 0.9174908999591634, 'sun.y');
    assertCloseRel(s.z, 0.397715512033647, 'sun.z');

    // Observer: equator (0, 0, alt 0 km).
    const p = observerTeme({ latDeg: 0, lonDeg: 0, altKm: 0 }, tMs).position;
    assertCloseRel(p.x, -0.013863225200351107, 'observer.x');
    assertCloseRel(p.y, -1.001024240721821, 'observer.y');
    assertCloseRel(p.z, 0, 'observer.z');
  });

  it('2026-12-21T00:00:00Z (December solstice)', () => {
    const tMs = 1797811200000;
    assertCloseRel(gmst(tMs), 1.5634664365592292, 'gmst');

    const s = sunDirection(tMs);
    assertCloseRel(s.x, -0.015367559757166542, 'sun.x');
    assertCloseRel(s.y, -0.9173980621953995, 'sun.y');
    assertCloseRel(s.z, -0.3976740293094783, 'sun.z');

    // Observer: Sydney (-33.8688, 151.2093, alt 0.05 km).
    const p = observerTeme({ latDeg: -33.8688, lonDeg: 151.2093, altKm: 0.05 }, tMs).position;
    assertCloseRel(p.x, -0.4060920978863528, 'observer.x');
    assertCloseRel(p.y, -0.7262985629215899, 'observer.y');
    assertCloseRel(p.z, -0.5547638129910494, 'observer.z');
  });
});
