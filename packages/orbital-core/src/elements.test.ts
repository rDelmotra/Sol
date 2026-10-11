import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  semiMajorAxisKmFromMeanMotion,
  orbitShape,
  eccentricAnomaly,
  orbitPosition,
  orbitPoint3D,
  type OrbitElements,
} from './elements.js';
import { ER_KM } from './units.js';

describe('elements: semiMajorAxisKmFromMeanMotion', () => {
  it('returns null for null, zero, or negative mean motion', () => {
    assert.equal(semiMajorAxisKmFromMeanMotion(null), null);
    assert.equal(semiMajorAxisKmFromMeanMotion(0), null);
    assert.equal(semiMajorAxisKmFromMeanMotion(-1), null);
  });

  it('an ISS-like ~15.5 rev/day mean motion gives a LEO semi-major axis', () => {
    const sma = semiMajorAxisKmFromMeanMotion(15.5);
    assert.ok(sma !== null && Math.abs(sma - 6768) < 30, `sma ${String(sma)}`);
  });

  it('a GEO ~1.0027 rev/day mean motion gives a ~42164 km semi-major axis', () => {
    const sma = semiMajorAxisKmFromMeanMotion(1.0027);
    assert.ok(sma !== null && Math.abs(sma - 42164) < 50, `sma ${String(sma)}`);
  });

  it('matches the direct Kepler formula bit-for-bit', () => {
    const n = 14.2;
    const radPerSec = (n * 2 * Math.PI) / 86400;
    const expected = Math.cbrt(398600.4418 / (radPerSec * radPerSec));
    assert.equal(semiMajorAxisKmFromMeanMotion(n), expected);
  });
});

describe('elements: two-body orbit shape', () => {
  const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const el = (over: Partial<OrbitElements>): OrbitElements => ({
    meanMotionRevPerDay: 2,
    eccentricity: 0.5,
    meanAnomalyDeg: 0,
    inclinationDeg: 0,
    raanDeg: 0,
    argPerigeeDeg: 0,
    epochMs: T0,
    ...over,
  });

  it('ISS-like mean motion gives a ~400 km orbit', () => {
    const s = orbitShape({ meanMotionRevPerDay: 15.5, eccentricity: 0.0003 })!;
    near(s.a - ER_KM, 410, 40);
  });

  it('perigee/apogee radii bracket a with eccentricity e', () => {
    const s = orbitShape({ meanMotionRevPerDay: 2, eccentricity: 0.5 })!;
    near(s.rp, s.a * 0.5, 1e-6);
    near(s.ra, s.a * 1.5, 1e-6);
  });

  it('rejects unbound or missing elements', () => {
    assert.equal(orbitShape({ meanMotionRevPerDay: 2, eccentricity: 1.2 }), null);
    assert.equal(orbitShape({ meanMotionRevPerDay: 0, eccentricity: 0.1 }), null);
    assert.equal(orbitShape({ meanMotionRevPerDay: NaN, eccentricity: NaN }), null);
  });

  it('Kepler solver: satisfies M = E - e sin E, and E = M when e = 0', () => {
    for (const e of [0, 0.1, 0.7, 0.95]) {
      for (const M of [0.1, 1, 2.5, 3.1, 5, 6.2]) {
        const E = eccentricAnomaly(M, e);
        near(E - e * Math.sin(E), M, 1e-9);
      }
    }
    near(eccentricAnomaly(1.234, 0), 1.234, 1e-12);
  });

  it('at epoch with M=0 the object is at perigee on +x', () => {
    const p = orbitPosition(el({}), T0)!;
    const s = orbitShape(el({}))!;
    near(p.r, s.rp, 1e-6);
    near(p.y, 0, 1e-6);
  });

  it('half a period later it is at apogee on -x', () => {
    const half = (86400 / 2 / 2) * 1000; // period = 86400/2 s, so half = 21600 s
    const p = orbitPosition(el({}), T0 + half)!;
    const s = orbitShape(el({}))!;
    near(p.r, s.ra, 1e-3);
    assert.ok(p.x < 0);
  });

  it('position depends only on time since epoch; a non-finite epoch is rejected', () => {
    const a = orbitPosition(el({ meanMotionRevPerDay: 15, eccentricity: 0.001, meanAnomalyDeg: 10 }), T0 + 600_000)!;
    const b = orbitPosition(
      el({ meanMotionRevPerDay: 15, eccentricity: 0.001, meanAnomalyDeg: 10, epochMs: T0 + 3_600_000 }),
      T0 + 3_600_000 + 600_000,
    )!;
    near(a.trueAnomaly, b.trueAnomaly, 1e-9);
    assert.equal(orbitPosition(el({ epochMs: NaN }), T0), null);
  });

  it('3D: equatorial orbit stays in z=0; polar orbit reaches the pole', () => {
    const eq = orbitPoint3D({ raanDeg: 40, argPerigeeDeg: 10, inclinationDeg: 0 }, 7000, 1.2)!;
    near(eq.z, 0, 1e-9);
    near(Math.hypot(eq.x, eq.y), 7000, 1e-6);
    const polar = orbitPoint3D({ raanDeg: 0, argPerigeeDeg: 0, inclinationDeg: 90 }, 7000, Math.PI / 2)!;
    near(polar.z, 7000, 1e-6);
  });

  it('3D: radius is preserved and max |z| = r sin(incl)', () => {
    let maxZ = 0;
    for (let nu = 0; nu < 6.3; nu += 0.01) {
      const p = orbitPoint3D({ raanDeg: 123, argPerigeeDeg: 77, inclinationDeg: 51.6 }, 7000, nu)!;
      near(Math.hypot(p.x, p.y, p.z), 7000, 1e-6);
      maxZ = Math.max(maxZ, Math.abs(p.z));
    }
    near(maxZ, 7000 * Math.sin((51.6 * Math.PI) / 180), 2);
  });
});
