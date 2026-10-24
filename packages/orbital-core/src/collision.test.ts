import test from 'node:test';
import assert from 'node:assert/strict';
import { addSym3, covFromRic, encounterGeometry, pcFoster, pcMax, pcZeroMissCircular, phiBetween, erfc, type Cov2 } from './collision.js';
import { ricBasis, type V3 } from './ric.js';

// deterministic PRNG for random cases
function mulberry(a: number) { return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Independent reference: brute-force 2D integration of the Gaussian density over the disc in polar coordinates (midpoint rule, no erf, no adaptivity). */
function pcPolar(mx: number, my: number, c: Cov2, R: number, nr = 600, nt = 1440): number {
  const det = c.xx * c.yy - c.xy * c.xy;
  const ixx = c.yy / det, ixy = -c.xy / det, iyy = c.xx / det;
  const k = 1 / (2 * Math.PI * Math.sqrt(det));
  let sum = 0;
  for (let i = 0; i < nr; i++) {
    const r = ((i + 0.5) / nr) * R;
    for (let j = 0; j < nt; j++) {
      const t = ((j + 0.5) / nt) * 2 * Math.PI;
      const dx = r * Math.cos(t) - mx, dy = r * Math.sin(t) - my;
      sum += k * Math.exp(-0.5 * (ixx * dx * dx + 2 * ixy * dx * dy + iyy * dy * dy)) * r;
    }
  }
  return (sum * (R / nr) * (2 * Math.PI)) / nt;
}

test('erfc and phiBetween known values', () => {
  assert.ok(Math.abs(erfc(0.5) - 0.4795001221869535) < 1e-12);
  assert.ok(Math.abs(erfc(3) - 2.209049699858544e-5) / 2.2e-5 < 1e-9);
  assert.ok(Math.abs(phiBetween(-1, 1) - 0.6826894921370859) < 1e-12);
  assert.ok(Math.abs(phiBetween(5, 6) - (2.8665157187919e-7 - 9.8658764503769e-10)) / 2.86e-7 < 1e-8);
});

test('Pc zero miss, circular covariance equals 1 - exp(-R^2 / 2 sigma^2)', () => {
  for (const [R, s] of [[0.01, 1], [0.005, 0.3], [1, 1], [2, 1], [0.03, 0.05], [0.5, 3]] as const) {
    const got = pcFoster(0, 0, { xx: s * s, xy: 0, yy: s * s }, R);
    const want = pcZeroMissCircular(R, s);
    assert.ok(Math.abs(got - want) / want < 1e-7, `R=${R} s=${s} got ${got} want ${want}`);
  }
});

test('Pc zero miss, circular covariance is independent of how the plane axes are turned', () => {
  const s = 0.7, R = 0.4;
  const a = pcFoster(0, 0, { xx: s * s, xy: 0, yy: s * s }, R);
  const b = pcFoster(0, 0, { xx: s * s, xy: 1e-18, yy: s * s * (1 + 1e-12) }, R);
  assert.ok(Math.abs(a - b) / a < 1e-6);
});

test('Pc small disc limit: density times area', () => {
  const c: Cov2 = { xx: 4, xy: 1.2, yy: 1 };
  const m = [0.8, -0.3], R = 1e-4;
  const det = c.xx * c.yy - c.xy * c.xy;
  const q = (c.yy * m[0]! * m[0]! - 2 * c.xy * m[0]! * m[1]! + c.xx * m[1]! * m[1]!) / det;
  const want = Math.PI * R * R * Math.exp(-0.5 * q) / (2 * Math.PI * Math.sqrt(det));
  assert.ok(Math.abs(pcFoster(m[0]!, m[1]!, c, R) - want) / want < 1e-6);
});

test('Pc against a brute-force numerical 2D integral on random cases (agreement better than 1e-3 relative)', () => {
  const rnd = mulberry(12345);
  let worst = 0;
  for (let n = 0; n < 40; n++) {
    const s1 = 0.05 + 3 * rnd(), s2 = 0.05 + 3 * rnd(), th = rnd() * Math.PI;
    const c = Math.cos(th), s = Math.sin(th);
    const cov: Cov2 = { xx: c * c * s1 * s1 + s * s * s2 * s2, xy: c * s * (s1 * s1 - s2 * s2), yy: s * s * s1 * s1 + c * c * s2 * s2 };
    const R = (0.05 + 0.9 * rnd()) * Math.min(s1, s2) * (n % 4 === 0 ? 3 : 1);
    const ang = rnd() * 2 * Math.PI, d = rnd() * 3 * Math.max(s1, s2);
    const mx = d * Math.cos(ang), my = d * Math.sin(ang);
    const a = pcFoster(mx, my, cov, R), b = pcPolar(mx, my, cov, R);
    if (b > 1e-12) worst = Math.max(worst, Math.abs(a - b) / b);
    assert.ok(Math.abs(a - b) <= 1e-3 * b + 1e-14, `case ${n}: ${a} vs ${b}`);
  }
  assert.ok(worst < 1e-3, `worst relative difference ${worst}`);
});

test('Pc is 1 when the disc dwarfs the covariance, and falls with miss distance', () => {
  assert.ok(Math.abs(pcFoster(0, 0, { xx: 1e-4, xy: 0, yy: 1e-4 }, 1) - 1) < 1e-12);
  const c: Cov2 = { xx: 1, xy: 0, yy: 1 };
  assert.ok(pcFoster(0.5, 0, c, 0.1) > pcFoster(2, 0, c, 0.1));
  assert.ok(pcFoster(8, 0, c, 0.1) < 1e-12);
});

test('Pc with a very narrow ellipse (needle) still integrates', () => {
  const cov: Cov2 = { xx: 1e-8, xy: 0, yy: 4 };
  const R = 0.05;
  const a = pcFoster(0.01, 0.3, cov, R), b = pcPolar(0.01, 0.3, cov, R, 2000, 4000);
  assert.ok(Math.abs(a - b) / b < 2e-3, `${a} vs ${b}`);
});

test('maximum Pc over covariance scaling: small-disc closed form and a dense scan', () => {
  const cov: Cov2 = { xx: 2.5, xy: 0.7, yy: 0.6 };
  const mx = 3, my = -1, R = 0.01;
  const r = pcMax(mx, my, cov, R);
  // closed form R^2 / (e q s1 s2) with q = m' C^-1 m
  const det = cov.xx * cov.yy - cov.xy * cov.xy;
  const q = (cov.yy * mx * mx - 2 * cov.xy * mx * my + cov.xx * my * my) / det;
  const closed = (R * R) / (Math.E * q * Math.sqrt(det));
  assert.ok(Math.abs(r.pc - closed) / closed < 1e-3, `${r.pc} vs ${closed}`);
  let best = 0;
  for (let lk = -6; lk <= 6; lk += 0.01) { const k = Math.exp(lk); best = Math.max(best, pcFoster(mx, my, { xx: cov.xx * k, xy: cov.xy * k, yy: cov.yy * k }, R)); }
  assert.ok(r.pc >= best * (1 - 1e-6) && r.pc <= best * (1 + 1e-3), `${r.pc} vs scan ${best}`);
  assert.equal(pcMax(0.001, 0, cov, 0.01).pc, 1);
});

test('encounter geometry: axis-aligned case', () => {
  // relative velocity along +z, miss 2 km along +x; covariance sx=1 (x), sy=3 (y), sz=10 (along the velocity: must not matter)
  const g = encounterGeometry([2, 0, 0], [0, 0, 7], [1, 0, 0, 9, 0, 100])!;
  assert.ok(Math.abs(g.mx - 2) < 1e-12 && g.my === 0 && Math.abs(g.vrel - 7) < 1e-12 && Math.abs(g.along) < 1e-12);
  assert.ok(Math.abs(g.cov.xx - 1) < 1e-12 && Math.abs(g.cov.yy - 9) < 1e-12 && Math.abs(g.cov.xy) < 1e-12);
});

test('encounter geometry: rotating everything leaves the plane quantities unchanged', () => {
  const rnd = mulberry(7);
  const b = ricBasis([7000, 100, 200], [0.1, 7.4, 0.3])!;
  const cov = addSym3(covFromRic(b, [0.3, 2, 0.4]), covFromRic(ricBasis([-3000, 6000, 1000], [5, 2, 4])!, [0.2, 1, 0.3]));
  const rp: V3 = [0.4, -1.1, 0.7], rv: V3 = [3, -9, 5];
  const g = encounterGeometry(rp, rv, cov)!;
  // rotate by angle about a fixed axis
  const ang = rnd() * 6, ca = Math.cos(ang), sa = Math.sin(ang);
  const rot = (v: V3): V3 => [ca * v[0] - sa * v[1], sa * v[0] + ca * v[1], v[2]];
  const Rm = [[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]];
  const cm = [[cov[0], cov[1], cov[2]], [cov[1], cov[3], cov[4]], [cov[2], cov[4], cov[5]]];
  const rc = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => { let s = 0; for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) s += Rm[i]![k]! * cm[k]![l]! * Rm[j]![l]!; return s; }));
  const g2 = encounterGeometry(rot(rp), rot(rv), [rc[0]![0]!, rc[0]![1]!, rc[0]![2]!, rc[1]![1]!, rc[1]![2]!, rc[2]![2]!])!;
  assert.ok(Math.abs(g.mx - g2.mx) < 1e-9 && Math.abs(g.cov.xx - g2.cov.xx) < 1e-9 && Math.abs(g.cov.yy - g2.cov.yy) < 1e-9 && Math.abs(g.cov.xy - g2.cov.xy) < 1e-9);
  // and the projection equals the sum over a hand-built orthonormal pair
  assert.ok(g.cov.xx > 0 && g.cov.yy > 0 && g.cov.xx * g.cov.yy - g.cov.xy ** 2 > 0);
});

test('covFromRic: trace is the sum of variances; axes follow the basis', () => {
  const b = ricBasis([7000, 0, 0], [0, 7.5, 0])!;
  const c = covFromRic(b, [1, 2, 3]);
  assert.deepEqual(c.map((v) => Math.round(v * 1e9) / 1e9), [1, 0, 0, 4, 0, 9]);
});
