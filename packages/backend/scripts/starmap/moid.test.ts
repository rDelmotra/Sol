// SPIKE — not production. MOID validation against known answers and a dense brute force.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moid, moidPrepared, moidBrute, wireFromElements, sampleWire, distToWire, wirePoint } from './moid.js';
import { type Elements } from './invariants.js';
import { rng } from './catalog.js';

const D = Math.PI / 180;
const el = (a: number, e: number, iDeg: number, raanDeg: number, argpDeg: number): Elements => ({
  norad: 0, a, e, i: iDeg * D, raan: raanDeg * D, argp: argpDeg * D, m0: 0, n: 0, epochMs: 0,
  rp: a * (1 - e), ra: a * (1 + e), raanDot: 0, argpDot: 0,
});

test('coplanar circles: |r1 - r2|', () => {
  assert.ok(Math.abs(moid(el(7000, 0, 30, 10, 0), el(7500, 0, 30, 10, 0), 0).dist - 500) < 1e-6);
});
test('circles, different planes, different radii: |r1 - r2|', () => {
  assert.ok(Math.abs(moid(el(7000, 0, 30, 10, 0), el(7500, 0, 80, 120, 0), 0).dist - 500) < 1e-6);
});
test('equal-radius circles in different planes: 0 at the node line', () => {
  assert.ok(moid(el(7000, 0, 30, 10, 0), el(7000, 0, 98, 200, 0), 0).dist < 1e-6);
});
test('coplanar ellipse inside circle: apogee gap', () => {
  // ellipse a=8000 e=0.1 (rp 7200, ra 8800) vs circle r=9500 in the same plane: min gap = 9500-8800
  assert.ok(Math.abs(moid(el(8000, 0.1, 40, 50, 70), el(9500, 0, 40, 50, 0), 0).dist - 700) < 1e-6);
});
test('elliptic vs circular matches a 3600x3600 brute force', () => {
  const wa = wireFromElements(el(10000, 0.3, 30, 20, 40), 0), wb = wireFromElements(el(8000, 0, 70, 100, 0), 0);
  const m = moid(el(10000, 0.3, 30, 20, 40), el(8000, 0, 70, 100, 0), 0).dist;
  const b = moidBrute(wa, wb, 3600);
  assert.ok(m <= b + 1e-9, `moid ${m} should not exceed brute ${b}`);
  assert.ok(b - m < 2, `brute ${b} vs moid ${m}`);
});
test('random pairs: never worse than a 720x720 brute force, close to a 3600x3600 one', () => {
  const r = rng(7);
  let worst = 0;
  for (let k = 0; k < 12; k++) {
    const A = el(6800 + r() * 3000, r() * 0.5, r() * 120, r() * 360, r() * 360);
    const B = el(6800 + r() * 3000, r() * 0.5, r() * 120, r() * 360, r() * 360);
    const wa = wireFromElements(A, 0), wb = wireFromElements(B, 0);
    const m = moidPrepared(wa, sampleWire(wa), wb, sampleWire(wb)).dist;
    const b = moidBrute(wa, wb, k < 3 ? 3600 : 720);
    assert.ok(m <= b + 1e-9, `pair ${k}: moid ${m} > brute ${b}`);
    worst = Math.max(worst, b - m);
  }
  assert.ok(worst < 25, `worst brute-minus-moid ${worst}`);
});
test('near-circular LEO-like pairs (the hard case: many shallow basins): never worse than a 720x720 brute force', () => {
  const r = rng(11);
  let worst = 0, n = 0;
  for (let k = 0; k < 400; k++) {
    const A = el(6900 + r() * 900, r() * 0.03, 20 + r() * 100, r() * 360, r() * 360);
    const B = el(6900 + r() * 900, r() * 0.03, 20 + r() * 100, r() * 360, r() * 360);
    const wa = wireFromElements(A, 0), wb = wireFromElements(B, 0);
    const m = moidPrepared(wa, sampleWire(wa), wb, sampleWire(wb)).dist;
    const b = moidBrute(wa, wb, 720);
    assert.ok(m <= b + 1e-6, `pair ${k}: moid ${m} > brute ${b}`);
    worst = Math.max(worst, b - m); n++;
  }
  console.log(`near-circular: ${n} pairs, worst brute(720^2)-moid = ${worst.toFixed(2)} km`);
});
test('regression: 38500 vs 42170 (two near-circular debris; the first version polished only the 4 best coarse minima and returned 232 km, true ~5.9 km)', () => {
  const A: Elements = { ...el(7327, 0.0203, 98.6469, 0, 0), norad: 1 };
  const B = el(7454, 0.0198, 82.7645, 0, 0);
  const m = moid(A, B, 0).dist, wa = wireFromElements(A, 0), wb = wireFromElements(B, 0);
  assert.ok(m <= moidBrute(wa, wb, 1440) + 1e-6);
});
test('distToWire: point on / off the wire', () => {
  const w = wireFromElements(el(7000, 0.2, 50, 30, 60), 0);
  const p = wirePoint(w, 1.234, [0, 0, 0]) as number[];
  assert.ok(distToWire(w, p[0]!, p[1]!, p[2]!) < 1e-6);
  // 10 km radially outward from a circle
  const c = wireFromElements(el(7000, 0, 0, 0, 0), 0);
  assert.ok(Math.abs(distToWire(c, 7010, 0, 0) - 10) < 1e-6);
});
test('speed: ms per pair (informational)', () => {
  const r = rng(3);
  const ws: Array<[Float64Array, Float64Array]> = [];
  for (let k = 0; k < 400; k++) {
    const w = wireFromElements(el(6800 + r() * 1500, r() * 0.1, r() * 100, r() * 360, r() * 360), 0);
    ws.push([w, sampleWire(w)]);
  }
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < Math.min(ws.length, i + 25); j++) { moidPrepared(ws[i]![0], ws[i]![1], ws[j]![0], ws[j]![1]); n++; }
  console.log(`MOID speed: ${(((performance.now() - t0) * 1000) / n).toFixed(1)} us/pair over ${n} pairs`);
});
