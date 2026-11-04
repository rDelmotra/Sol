import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { temeToJ2000, j2000ToTeme, rotateBetweenDates, temeToJ2000Matrix, nutation80, centuriesTT, ttMinusUtcSeconds, precessionMatrix, matMul, matTranspose } from './frames.js';
import { norm, sub } from './vec.js';

const km = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => norm(sub(a, b));

describe('frames: TEME <-> J2000', () => {
  // Vallado, Crawford, Hujsak & Kelso (2006), "Revisiting Spacetrack Report #3", AIAA 2006-6753, and Vallado, Fundamentals of
  // Astrodynamics and Applications 4th ed., example 3-15: UTC 2004-04-06 07:51:28.386009, dUT1 = -0.4399619 s, dAT = 32 s.
  //   r_TEME  = 5094.18016210  6127.64465950  6380.34453270 km
  //   r_GCRF  = 5102.508958    6123.011401    6378.136928    km   (IAU-2000/2006 reduction of the same point)
  // The classical IAU-76/FK5 + IAU-80 chain differs from the CIO-based GCRF reduction by the FK5 frame bias and nutation-model
  // differences (a metre or two); the paper's own TEME -> J2000 line (5102.50960000 6123.01152000 6378.13630000) is that chain.
  const t = Date.UTC(2004, 3, 6, 7, 51, 28, 386);
  const teme = { x: 5094.18016210, y: 6127.64465950, z: 6380.34453270 };
  const gcrf = { x: 5102.508958, y: 6123.011401, z: 6378.136928 };
  const paperJ2000 = { x: 5102.50960000, y: 6123.01152000, z: 6378.13630000 };

  it('Vallado 2006 vector: TEME -> J2000 agrees with the published GCRF to 2 m and with the paper\'s J2000 line to 0.5 m', () => {
    const r = temeToJ2000(teme, t);
    assert.ok(km(r, gcrf) < 0.002, `vs GCRF: ${km(r, gcrf) * 1000} m`);
    assert.ok(km(r, paperJ2000) < 0.0005, `vs paper J2000: ${km(r, paperJ2000) * 1000} m`);
    assert.ok(Math.abs(norm(r) - norm(teme)) < 1e-9, 'a rotation keeps the length');
  });

  it('round trip TEME -> J2000 -> TEME is the identity (1e-9 km)', () => {
    const back = j2000ToTeme(temeToJ2000(teme, t), t);
    assert.ok(km(back, teme) < 1e-9);
  });

  it('the matrix is orthonormal with determinant +1', () => {
    const m = temeToJ2000Matrix(t);
    const i = matMul(m, matTranspose(m));
    for (let k = 0; k < 9; k++) assert.ok(Math.abs(i[k]! - (k % 4 === 0 ? 1 : 0)) < 1e-14);
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    assert.ok(Math.abs(det - 1) < 1e-14);
  });

  it('other dates vs an independent implementation (astropy 8 / ERFA, TEME -> GCRS of [7000, -1500, 2500] km): within 3 m', () => {
    const v = { x: 7000, y: -1500, z: 2500 };
    const ref: Array<[string, { x: number; y: number; z: number }]> = [
      ['1962-03-01T06:00:00Z', { x: 7003.146951, y: -1440.841975, z: 2525.847815 }],
      ['1985-06-01T12:00:00Z', { x: 7001.239367, y: -1477.098959, z: 2510.144616 }],
      ['2024-10-01T18:30:00Z', { x: 6997.571106, y: -1538.621869, z: 2483.272308 }],
    ];
    for (const [iso, want] of ref) {
      const d = km(temeToJ2000(v, Date.parse(iso)), want);
      assert.ok(d < 0.003, `${iso}: ${d * 1000} m`);
    }
  });

  it('rotateBetweenDates: same date is the identity; 24 h apart rotates by ~ the precession + nutation drift (~0.14" per day); composes', () => {
    const v = { x: 7000, y: -1500, z: 2500 };
    const t0 = Date.UTC(2026, 5, 1), t1 = t0 + 86_400_000, t2 = t0 + 10 * 86_400_000;
    assert.deepEqual(rotateBetweenDates(v, t0, t0), v);
    const d1 = km(rotateBetweenDates(v, t0, t1), v);
    // precession ~50.3"/yr = 0.138"/day plus nutation wobble: of the order of 7500 km * 0.15" = 5 m, certainly < 50 m and > 0.5 m
    assert.ok(d1 > 0.0005 && d1 < 0.05, `1 day: ${d1 * 1000} m`);
    const direct = rotateBetweenDates(v, t0, t2);
    const viaT1 = rotateBetweenDates(rotateBetweenDates(v, t0, t1), t1, t2);
    assert.ok(km(direct, viaT1) < 1e-9);
    assert.ok(km(rotateBetweenDates(rotateBetweenDates(v, t0, t2), t2, t0), v) < 1e-9);
  });

  it('nutation: bounded (|dpsi| < 20", |deps| < 10") and the J2000.0 value', () => {
    for (let y = 1960; y <= 2030; y += 2) {
      const n = nutation80(centuriesTT(Date.UTC(y, 0, 1)));
      assert.ok(Math.abs(n.dpsi) < 20 / 206264.806 && Math.abs(n.deps) < 10 / 206264.806);
    }
    // at J2000.0 the IAU-80 series itself gives dpsi = -13.923", deps = -5.774" (checked against ERFA nut80)
    const n = nutation80(0);
    assert.ok(Math.abs(n.dpsi * 206264.806 - (-13.923)) < 0.05, `${n.dpsi * 206264.806}`);
    assert.ok(Math.abs(n.deps * 206264.806 - (-5.774)) < 0.05, `${n.deps * 206264.806}`);
  });

  it('precession matrix at T = 0 is the identity; leap second table', () => {
    const p = precessionMatrix(0);
    for (let k = 0; k < 9; k++) assert.ok(Math.abs(p[k]! - (k % 4 === 0 ? 1 : 0)) < 1e-15);
    assert.equal(ttMinusUtcSeconds(Date.UTC(2004, 3, 6)), 64.184);
    assert.equal(ttMinusUtcSeconds(Date.UTC(2026, 0, 1)), 69.184);
  });
});
