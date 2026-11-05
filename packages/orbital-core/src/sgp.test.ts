// SGP (Spacetrack Report #3). The report's published SGP output numbers are NOT used (not recovered reliably); these tests check the
// model by internal consistency. Agreement with satellite.js SGP4 on drag-free orbits is tested in the backend
// (tests/ssa/history-propagator.test.ts), since orbital-core may not import satellite.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sgpElementsFromOmm, sgpInit, sgpPropagate, SGP_AE_KM, type SgpElements } from './sgp.js';

// orbit shape of the report's test element set (used as an input only)
const LEO: SgpElements = {
  meanMotionRevDay: 16.05824518, eccentricity: 0.0086731, inclinationDeg: 72.8435, raanDeg: 115.9689, argPerigeeDeg: 52.6988,
  meanAnomalyDeg: 110.5714, ndot2RevDay2: 0, nddot6RevDay3: 0,
};
const norm = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!, v[2]!);
const sub = (a: readonly number[], b: readonly number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];

test('unusable elements give no record', () => {
  assert.equal(sgpInit({ ...LEO, eccentricity: 1 }), null);
  assert.equal(sgpInit({ ...LEO, eccentricity: -0.1 }), null);
  assert.equal(sgpInit({ ...LEO, meanMotionRevDay: 0 }), null);
  assert.equal(sgpInit({ ...LEO, inclinationDeg: NaN }), null);
  assert.ok(sgpInit(LEO));
});

// SGP's velocity (as in the report) leaves out the time derivatives of its J2 short-period position terms: ~2 m/s in LEO.
test('velocity is the time derivative of position (central difference) to the short-period terms, < 5 m/s', () => {
  const s = sgpInit({ ...LEO, ndot2RevDay2: 1e-4 })!;
  for (const t of [0, 37, 360, 1440]) {
    const h = 1e-3; // min
    const a = sgpPropagate(s, t - h)!, b = sgpPropagate(s, t + h)!, c = sgpPropagate(s, t)!;
    const num = sub(b.position, a.position).map((q) => q / (2 * h * 60)); // km/s
    assert.ok(norm(sub(num, c.velocity)) < 5e-3, `t=${t}: |v - dr/dt| = ${norm(sub(num, c.velocity))} km/s`);
  }
});

test('drag-free orbit: radius stays between perigee and apogee, energy matches the mean semi-major axis', () => {
  const s = sgpInit(LEO)!;
  const aKm = s.a0 * SGP_AE_KM;
  for (let t = 0; t <= 2880; t += 7) {
    const st = sgpPropagate(s, t)!;
    const r = norm(st.position), v = norm(st.velocity);
    assert.ok(r > aKm * (1 - LEO.eccentricity) - 15 && r < aKm * (1 + LEO.eccentricity) + 15, `r ${r} at ${t}`);
    const aVis = 1 / (2 / r - (v * v) / 398600.8); // WGS-72 GM
    assert.ok(Math.abs(aVis - aKm) / aKm < 3e-3, `vis-viva a ${aVis} vs ${aKm}`);
  }
});

test('the drag term: along-track drift = 2 pi (ndot/2) t^2 rev, the epoch state unchanged', () => {
  const nd2 = 2e-4; // rev/day^2
  const s0 = sgpInit(LEO)!, s1 = sgpInit({ ...LEO, ndot2RevDay2: nd2 })!;
  assert.deepEqual(sgpPropagate(s1, 0), sgpPropagate(s0, 0));
  for (const days of [0.5, 1, 2]) {
    const a = sgpPropagate(s0, days * 1440)!, b = sgpPropagate(s1, days * 1440)!;
    // the angle between the two position vectors (the drift is along the orbit)
    const cos = (a.position[0] * b.position[0] + a.position[1] * b.position[1] + a.position[2] * b.position[2]) / (norm(a.position) * norm(b.position));
    const ang = Math.acos(Math.min(1, cos));
    const want = 2 * Math.PI * nd2 * days * days;
    assert.ok(Math.abs(ang - want) / want < 0.06, `${days} d: drift ${ang} rad, expected ${want}`);
    // b is ahead (a decaying orbit speeds up) and lower
    assert.ok(norm(b.position) < norm(a.position) + 1);
  }
});

test('semi-major axis decays as the mean motion grows: n(t) = n0 + 2 (ndot/2) t', () => {
  const nd2 = 1e-3;
  const s = sgpInit({ ...LEO, ndot2RevDay2: nd2 })!;
  // mean radius over one revolution at t0 and at t0 + 1 day, ratio vs (n0 / n1)^(2/3)
  const meanR = (t0: number) => { let sum = 0; const N = 200, P = 1440 / LEO.meanMotionRevDay; for (let k = 0; k < N; k++) sum += norm(sgpPropagate(s, t0 + (k * P) / N)!.position); return sum / N; };
  const ratio = meanR(1440) / meanR(0);
  const want = Math.pow(LEO.meanMotionRevDay / (LEO.meanMotionRevDay + 2 * nd2), 2 / 3);
  assert.ok(Math.abs(ratio - want) < 2e-5, `${ratio} vs ${want}`);
});

test('a decayed model orbit gives null; OMM field mapping', () => {
  const s = sgpInit({ ...LEO, ndot2RevDay2: -1 })!; // n0 + 2 ndot t <= 0 after ~8 days
  assert.ok(sgpPropagate(s, 1440));
  assert.equal(sgpPropagate(s, 20 * 1440), null);
  const el = sgpElementsFromOmm({ MEAN_MOTION: 15.5, ECCENTRICITY: 0.001, INCLINATION: 51.6, RA_OF_ASC_NODE: 10, ARG_OF_PERICENTER: 20, MEAN_ANOMALY: 30, MEAN_MOTION_DOT: 1e-4 });
  assert.deepEqual(el, { meanMotionRevDay: 15.5, eccentricity: 0.001, inclinationDeg: 51.6, raanDeg: 10, argPerigeeDeg: 20, meanAnomalyDeg: 30, ndot2RevDay2: 1e-4, nddot6RevDay3: 0 });
});
