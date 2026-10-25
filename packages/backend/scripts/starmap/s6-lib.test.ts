// S6 pure maths: volumes, the conservative coarse-stage bound (on synthetic fly-bys propagated with the real SGP4), pre-filter counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as satellite from 'satellite.js';
import { rng } from './catalog.js';
import {
  SFS_VOLUMES, volumeIdFor, shapeFromOmm, halfDiagonal, inBox, inEllipsoid, windowCandidate, solveCell, maxSeparation, relAccelBound, minimumOffsetBound,
  radialCurvatureBound, radiusSpacing, radiusPad, shellCounts, findMinima, ricBasis, toRic, MU, type V3,
} from './s6-lib.js';

const EPOCH_MS = Date.parse('2026-10-12T12:00:00Z');
type Rec = ReturnType<typeof satellite.json2satrec>;
interface El { n: number; e: number; i: number; raan: number; argp: number; ma: number; bstar?: number }
function mk(el: El): Rec {
  return satellite.json2satrec({
    OBJECT_NAME: 'SYN', OBJECT_ID: '2026-001A', EPOCH: new Date(EPOCH_MS).toISOString(), MEAN_MOTION: el.n, ECCENTRICITY: el.e, INCLINATION: el.i,
    RA_OF_ASC_NODE: el.raan, ARG_OF_PERICENTER: el.argp, MEAN_ANOMALY: el.ma, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: 99999,
    ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1, BSTAR: el.bstar ?? 0, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
  } as never);
}
const stateAt = (s: Rec, tMs: number): { r: V3; v: V3 } => {
  const o = satellite.sgp4(s, (tMs - EPOCH_MS) / 60_000) as { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number } };
  return { r: [o.position.x, o.position.y, o.position.z], v: [o.velocity.x, o.velocity.y, o.velocity.z] };
};
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const nrm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

test('regime table: volume ids by perigee, period, eccentricity, inclination', () => {
  const shape = (periodMin: number, ecc: number, incDeg: number, perigeeKm: number) => ({ periodMin, ecc, incDeg, perigeeKm });
  assert.equal(volumeIdFor(shape(1436, 0.001, 0.05, 35780)), 1); // GEO
  assert.equal(volumeIdFor(shape(1436, 0.001, 63, 35780)), 6); // inclined geosynchronous: not volume 1
  assert.equal(volumeIdFor(shape(93, 0.0005, 51.6, 415)), 5); // ISS: LEO1
  assert.equal(volumeIdFor(shape(95.6, 0.0001, 53, 550)), 4); // Starlink shell: LEO2
  assert.equal(volumeIdFor(shape(100, 0.001, 98, 800)), 3);
  assert.equal(volumeIdFor(shape(115, 0.001, 98, 1500)), 2);
});
test('regime table: eccentric and high orbits', () => {
  const shape = (periodMin: number, ecc: number, incDeg: number, perigeeKm: number) => ({ periodMin, ecc, incDeg, perigeeKm });
  assert.equal(volumeIdFor(shape(718, 0.7, 63.4, 500)), 6);
  assert.equal(volumeIdFor(shape(200, 0.4, 20, 300)), 7);
  assert.equal(volumeIdFor(shape(1.0, 1.2, 0, 0)), 8);
  assert.equal(volumeIdFor(shape(720, 0.001, 55, 20000)), 6); // MEO
  assert.equal(volumeIdFor(shape(93, 0.001, 51, -50)), 5); // decaying: perigee below the surface is still LEO1
  const iss = shapeFromOmm({ MEAN_MOTION: 15.48821882, ECCENTRICITY: 0.00067135, INCLINATION: 51.6312 });
  assert.ok(Math.abs(iss.periodMin - 92.98) < 0.05 && iss.perigeeKm > 400 && iss.perigeeKm < 430);
  assert.equal(SFS_VOLUMES.length, 8);
  assert.ok(Math.abs(halfDiagonal(SFS_VOLUMES[4]!) - 67.4) < 0.1);
});
test('box and ellipsoid membership', () => {
  const v = SFS_VOLUMES[4]!; // 0.4 / 44 / 51
  assert.ok(inBox([0.39, 43, -50], v) && !inBox([0.41, 0, 0], v) && !inBox([0, 44.1, 0], v));
  assert.ok(inEllipsoid([0, 44, 0], v) && !inEllipsoid([0.3, 40, 20], v) && inBox([0.3, 40, 20], v));
});

test('bound helpers: acceleration grows with separation, closed-form separation is a fixed point', () => {
  const rf = 6800;
  assert.ok(relAccelBound(1000, rf) > relAccelBound(10, rf));
  const D = maxSeparation(300, 15, 30, rf), a = relAccelBound(D, rf);
  assert.ok(Math.abs(D - (300 + 15 * 30 + 0.5 * a * 30 * 30)) < 1e-6);
  assert.equal(minimumOffsetBound(0.01, 5, 1, 0.1), Infinity); // slow pair: nothing can be excluded
  assert.ok(minimumOffsetBound(15, 10, 1, 0.08) < 1);
});

test('solveCell: cell covers the largest pair reach; cell and pads grow with the step', () => {
  const p = { hrMax: 67.4, wMax: 18, rFloor: 6370, omegaMax: 1.3e-3 };
  const a = solveCell({ ...p, h: 15 }), b = solveCell({ ...p, h: 30 }), c = solveCell({ ...p, h: 60 });
  assert.ok(a.L < b.L && b.L < c.L && a.epsCap < b.epsCap && b.epsCap < c.epsCap);
  assert.ok(b.L > 67.4 + 18 * 30);
  assert.ok(b.epsCap < 3, `eps cap at 60 s step ${b.epsCap}`);
});

// ---------------- synthetic fly-bys: the coarse stage must never drop a true encounter ----------------
interface Truth { tMs: number; ricB: V3; ricA: V3; miss: number }
/** every local minimum of the miss distance in [t0, t1] from a 2 s scan + root polish, with B's position in A's RIC and A's in B's */
function truthEvents(A: Rec, B: Rec, t0: number, t1: number): Truth[] {
  const rel = (t: number) => { const a = stateAt(A, t), b = stateAt(B, t); return { r: sub(b.r, a.r), v: sub(b.v, a.v) }; };
  return findMinima(rel, t0, t1, 2000, 0.5).map((tMs) => {
    const a = stateAt(A, tMs), b = stateAt(B, tMs), d = sub(b.r, a.r);
    const bA = ricBasis(a.r, a.v)!, bB = ricBasis(b.r, b.v)!;
    return { tMs, ricB: toRic(d, bA), ricA: toRic([-d[0], -d[1], -d[2]], bB), miss: nrm(d) };
  });
}
interface Cover { missed: Truth[]; candidates: number; gatherFail: number }
/**
 * The coarse stage as the screener runs it, for one pair and one sampling grid offset: at every sample the pair is tested in both
 * directions (B in A's volume, A in B's volume); every truth event inside a volume must fall in a candidate window of a sample whose
 * pair distance is inside the gather radius L.
 */
function coarseCovers(A: Rec, B: Rec, t0: number, t1: number, stepS: number, offsetS: number, truth: Truth[], volA: { u: number; v: number; w: number }, volB: { u: number; v: number; w: number }, wMax = 18, aScale = 1): Cover {
  const h = stepS / 2;
  const sa = (t: number) => stateAt(A, t), sb = (t: number) => stateAt(B, t);
  // radius floors from a scan of both orbits (the screener gets rlo from its radius pass)
  let rlo = Infinity, vmax = 0;
  for (let t = t0; t <= t1; t += 60_000) { for (const s of [sa(t), sb(t)]) { rlo = Math.min(rlo, nrm(s.r)); vmax = Math.max(vmax, nrm(s.v)); } }
  rlo -= 2;
  const hrMax = Math.max(halfDiagonal(volA), halfDiagonal(volB));
  const bound = solveCell({ hrMax, wMax, rFloor: rlo, omegaMax: (1.05 * vmax) / rlo, h });
  const covered = new Set<number>();
  let candidates = 0, gatherFail = 0;
  const windows: Array<[number, number, number]> = [];
  for (let t = t0 + offsetS * 1000 - stepS * 1000; t <= t1 + h * 1000; t += stepS * 1000) {
    const a = sa(t), b = sb(t);
    const r = sub(b.r, a.r), w = sub(b.v, a.v);
    const D = maxSeparation(nrm(r), nrm(w), h, rlo);
    const aRel = relAccelBound(D, rlo) * aScale;
    const om = (1.05 * vmax) / rlo;
    const c1 = windowCandidate({ r, w, pa: a.r, va: a.v, h, aRel, omega: om, half: [volA.u, volA.v, volA.w] });
    const c2 = windowCandidate({ r: [-r[0], -r[1], -r[2]], w: [-w[0], -w[1], -w[2]], pa: b.r, va: b.v, h, aRel, omega: om, half: [volB.u, volB.v, volB.w] });
    if (c1 || c2) { candidates++; windows.push([t - h * 1000, t + h * 1000, nrm(r)]); }
  }
  const missed: Truth[] = [];
  truth.forEach((e, k) => {
    const inV = (e.ricB[0] !== e.ricB[0]) ? false : inBox(e.ricB, volA) || inBox(e.ricA, volB);
    if (!inV) return;
    const win = windows.find((x) => e.tMs >= x[0] - 1 && e.tMs <= x[1] + 1);
    if (!win) missed.push(e);
    else { covered.add(k); if (win[2] > bound.L) gatherFail++; }
  });
  return { missed, candidates, gatherFail };
}

/**
 * Pair of LEO bodies on random planes that are engineered to pass within ~1 km of each other at time tm: B's plane is chosen to
 * contain A's position at tm, then raan and mean anomaly are corrected by Gauss-Newton on the SGP4 positions.
 */
function meetingPair(rand: () => number, tm: number): { A: Rec; B: Rec; elB: El } {
  const DEG = Math.PI / 180;
  const n = 15.0 + rand() * 0.3;
  const A = mk({ n, e: rand() * 3e-4, i: 20 + rand() * 80, raan: rand() * 360, argp: rand() * 360, ma: rand() * 360 });
  const pA = stateAt(A, tm).r, rr = nrm(pA), dec = Math.asin(pA[2] / rr), ra = Math.atan2(pA[1], pA[0]);
  const lo = Math.max(20 * DEG, Math.asin(Math.min(1, Math.abs(Math.sin(dec)) + 0.01)));
  const iB = lo + rand() * (Math.PI - 2 * lo); // inclination whose plane can contain A's position (sin i >= |sin dec|)
  let u = Math.asin(Math.sin(dec) / Math.sin(iB));
  if (rand() < 0.5) u = Math.PI - u;
  const dtDays = (tm - EPOCH_MS) / 86_400_000;
  const nB = n * (1 + (rand() - 0.5) * 2e-4);
  const el: El = { n: nB, e: rand() * 3e-4, i: iB / DEG, raan: ((ra - Math.atan2(Math.cos(iB) * Math.sin(u), Math.cos(u))) / DEG + 720) % 360, argp: 0, ma: ((u / DEG - nB * 360 * dtDays) % 360 + 720) % 360 };
  const pos = (e: El) => stateAt(mk(e), tm).r;
  for (let it = 0; it < 6; it++) {
    const f0 = sub(pos(el), pA), d = 0.01;
    const jr = sub(pos({ ...el, raan: el.raan + d }), pos(el)).map((x) => x / d) as V3, jm = sub(pos({ ...el, ma: el.ma + d }), pos(el)).map((x) => x / d) as V3;
    const a11 = jr[0] * jr[0] + jr[1] * jr[1] + jr[2] * jr[2], a12 = jr[0] * jm[0] + jr[1] * jm[1] + jr[2] * jm[2], a22 = jm[0] * jm[0] + jm[1] * jm[1] + jm[2] * jm[2];
    const b1 = -(jr[0] * f0[0] + jr[1] * f0[1] + jr[2] * f0[2]), b2 = -(jm[0] * f0[0] + jm[1] * f0[1] + jm[2] * f0[2]);
    const det = a11 * a22 - a12 * a12;
    el.raan += (b1 * a22 - b2 * a12) / det; el.ma += (a11 * b2 - a12 * b1) / det;
  }
  el.ma = (el.ma + (rand() - 0.5) * 0.6 + 720) % 360; // nudge along the track by up to +-0.3 deg (+-35 km)
  return { A, B: mk(el), elB: el };
}

test('synthetic head-on LEO fly-bys at 15 km/s are never missed by the coarse stage (steps 30, 60, 120 s, many grid offsets)', () => {
  const vol = SFS_VOLUMES[4]!; // LEO1, the largest LEO volume
  const rand = rng(11);
  let events = 0, inVolume = 0, windowsTested = 0;
  for (let k = 0; k < 80; k++) {
    // equatorial prograde vs equatorial retrograde at (almost) the same radius: relative speed ~ 15.3 km/s, one pass per half orbit
    const n = 15.1 + rand() * 0.3;
    const dn = (rand() - 0.5) * 2e-4; // ~ +-1.4 km in semi-major axis => radial miss up to ~1.4 km
    const A = mk({ n, e: 0.0002, i: 0.05, raan: 0, argp: 0, ma: rand() * 360 });
    const B = mk({ n: n * (1 + dn), e: 0.0002, i: 179.95, raan: 0, argp: 0, ma: rand() * 360 });
    const t0 = EPOCH_MS, t1 = EPOCH_MS + 6 * 3600_000;
    const truth = truthEvents(A, B, t0, t1);
    events += truth.length;
    inVolume += truth.filter((e) => inBox(e.ricB, vol) || inBox(e.ricA, vol)).length;
    for (const step of [30, 60, 120]) for (const off of [0, step * 0.13, step * 0.5, step * 0.87]) {
      const c = coarseCovers(A, B, t0, t1, step, off, truth, vol, vol);
      windowsTested++;
      assert.equal(c.missed.length, 0, `step ${step} offset ${off}: missed ${JSON.stringify(c.missed)}`);
      assert.equal(c.gatherFail, 0, 'candidate pair farther than the gather radius');
    }
  }
  assert.ok(inVolume >= 30, `test is vacuous: only ${inVolume} head-on encounters in the volume (of ${events} minima)`);
  assert.ok(windowsTested > 0);
});

test('synthetic crossing LEO orbits (random planes, engineered to meet) are never missed (LEO1 and LEO3 volumes)', () => {
  const rand = rng(5);
  let inVolume = 0;
  const speeds: number[] = [];
  for (let k = 0; k < 300; k++) {
    const t0 = EPOCH_MS, t1 = EPOCH_MS + 3 * 3600_000;
    const tm = t0 + (0.4 + 0.2 * rand()) * 3 * 3600_000;
    const T0 = Date.now();
    const { A, B } = meetingPair(rand, tm);
    const T1 = Date.now();
    const truth = truthEvents(A, B, t0, t1);
    if (process.env.S6_DEBUG) console.log(`pair ${k}: build ${T1 - T0} ms, truth ${Date.now() - T1} ms, ${truth.length} minima`);
    for (const vol of [SFS_VOLUMES[4]!, SFS_VOLUMES[2]!]) {
      const hit = truth.filter((e) => inBox(e.ricB, vol) || inBox(e.ricA, vol));
      inVolume += hit.length;
      for (const e of hit) { const a = stateAt(A, e.tMs), b = stateAt(B, e.tMs); speeds.push(nrm(sub(b.v, a.v))); }
      for (const step of [30, 60, 120]) {
        const c = coarseCovers(A, B, t0, t1, step, rand() * step, truth, vol, vol);
        assert.equal(c.missed.length, 0, `pair ${k} step ${step} vol ${vol.id}: missed ${JSON.stringify(c.missed)}`);
        assert.equal(c.gatherFail, 0);
      }
    }
  }
  speeds.sort((x, y) => x - y);
  assert.ok(inVolume >= 100, `test is vacuous: ${inVolume} encounters`);
  console.log(`# crossing test: ${inVolume} in-volume encounters, relative speed ${speeds[0]!.toFixed(2)}..${speeds[speeds.length - 1]!.toFixed(2)} km/s (median ${speeds[speeds.length >> 1]!.toFixed(2)})`);
});

test('negative control: with the acceleration bound removed the coarse stage does miss encounters at a 600 s step', () => {
  const rand = rng(5);
  const vol = SFS_VOLUMES[2]!; // LEO3, 0.4 x 12 x 12
  let missed = 0, inVolume = 0, missedWithBound = 0;
  for (let k = 0; k < 150; k++) {
    const t0 = EPOCH_MS, t1 = EPOCH_MS + 3 * 3600_000;
    const { A, B } = meetingPair(rand, t0 + (0.4 + 0.2 * rand()) * 3 * 3600_000);
    const truth = truthEvents(A, B, t0, t1);
    inVolume += truth.filter((e) => inBox(e.ricB, vol) || inBox(e.ricA, vol)).length;
    const off = rand() * 600;
    missed += coarseCovers(A, B, t0, t1, 600, off, truth, vol, vol, 18, 0).missed.length;
    missedWithBound += coarseCovers(A, B, t0, t1, 600, off, truth, vol, vol, 18, 1).missed.length;
  }
  assert.equal(missedWithBound, 0, 'the bound itself must not miss at 600 s either');
  assert.ok(inVolume > 30 && missed > 0, `control failed: ${missed} missed of ${inVolume}`);
  console.log(`# negative control: aRel = 0 misses ${missed} of ${inVolume} in-volume encounters at 600 s`);
});

test('synthetic slow GEO co-location is never missed at 300 and 600 s steps (volume 10 x 10 x 10)', () => {
  const rand = rng(3);
  const vol = SFS_VOLUMES[0]!;
  let inVolume = 0;
  const A = mk({ n: 1.0027, e: 1e-4, i: 0.05, raan: 100, argp: 0, ma: 40 });
  for (let k = 0; k < 60; k++) {
    // same slot with small element differences: the pair drifts past each other slowly (relative speeds of a few m/s to tens of m/s)
    const d1 = (rand() - 0.5) * 10, d2 = (rand() - 0.5) * 60; // raan and argp differ, but raan + argp + ma (the in-track position at small inclination) stays within ~0.05 deg
    const B = mk({ n: 1.0027 * (1 + (rand() - 0.5) * 2e-5), e: 1e-4 + (rand() - 0.5) * 1.5e-4 + 0.8e-4, i: 0.05 + (rand() - 0.5) * 0.02, raan: 100 + d1, argp: d2, ma: 40 - d1 - d2 + (rand() - 0.5) * 0.1 });
    const t0 = EPOCH_MS, t1 = EPOCH_MS + 36 * 3600_000;
    const truth = truthEvents(A, B, t0, t1);
    inVolume += truth.filter((e) => inBox(e.ricB, vol) || inBox(e.ricA, vol)).length;
    if (process.env.S6_DEBUG) console.log(`GEO ${k}: ${truth.length} minima, miss ${truth.map((e) => e.miss.toFixed(1)).join(' ')}; ric ${truth.map((e) => e.ricB.map((x) => x.toFixed(1)).join('/')).join(' ')}`);
    for (const step of [300, 600]) for (const off of [0, step * 0.37, step * 0.9]) {
      const c = coarseCovers(A, B, t0, t1, step, off, truth, vol, vol, 7);
      assert.equal(c.missed.length, 0, `GEO pair ${k} step ${step}: missed ${JSON.stringify(c.missed)}`);
      assert.equal(c.gatherFail, 0);
    }
  }
  assert.ok(inVolume >= 15, `test is vacuous: ${inVolume} co-location minima in the volume`);
  console.log(`# GEO test: ${inVolume} in-volume local minima`);
});

test('the extrapolation error of real SGP4 motion stays inside eps for gathered pairs (LEO, 60 s and 120 s windows)', () => {
  const rand = rng(8);
  let worstRatio = 0, pairs = 0;
  for (let k = 0; k < 120; k++) {
    const tm = EPOCH_MS + 3600_000 * (0.5 + rand());
    const { A, B } = meetingPair(rand, tm);
    for (const h of [30, 60]) {
      for (let t = tm - 600_000; t <= tm + 600_000; t += 7_300) {
        const a = stateAt(A, t), b = stateAt(B, t);
        const r = sub(b.r, a.r), w = sub(b.v, a.v);
        if (nrm(r) > 1500) continue; // gathered pairs only
        const rf = Math.min(nrm(a.r), nrm(b.r)) - 15 * h;
        const D = maxSeparation(nrm(r), nrm(w), h, rf), eps = 0.5 * relAccelBound(D, rf) * h * h;
        for (const tau of [-h, h]) {
          const a2 = stateAt(A, t + tau * 1000), b2 = stateAt(B, t + tau * 1000);
          const err = nrm(sub(sub(sub(b2.r, a2.r), r), [w[0] * tau, w[1] * tau, w[2] * tau]));
          worstRatio = Math.max(worstRatio, err / eps);
        }
        pairs++;
      }
    }
  }
  assert.ok(pairs > 500, `pairs ${pairs}`);
  assert.ok(worstRatio < 1, `actual extrapolation error reached ${(100 * worstRatio).toFixed(1)}% of the bound`);
  console.log(`# extrapolation error: worst ${(100 * worstRatio).toFixed(2)}% of the bound over ${pairs} gathered pair windows`);
});

test('a pair that cannot meet the volume is rejected (the test is not trivially true)', () => {
  const vol = SFS_VOLUMES[3]!; // 0.4 / 25 / 25
  const A = stateAt(mk({ n: 15.2, e: 0.0001, i: 53, raan: 0, argp: 0, ma: 0 }), EPOCH_MS);
  const far: V3 = [400, 300, 200];
  const w: V3 = [0.05, 0, 0];
  const aRel = relAccelBound(maxSeparation(nrm(far), 0.05, 30, 6800), 6800);
  assert.equal(windowCandidate({ r: far, w, pa: A.r, va: A.v, h: 30, aRel, omega: 1.2e-3, half: [vol.u, vol.v, vol.w] }), false);
  // a pair 1 km radially, 5 km along the track, closing slowly: candidate
  const B = ricBasis(A.r, A.v)!;
  const rel: V3 = [B.r[0] * 0.2 + B.i[0] * 5, B.r[1] * 0.2 + B.i[1] * 5, B.r[2] * 0.2 + B.i[2] * 5];
  assert.equal(windowCandidate({ r: rel, w: [0, 0, 0.001], pa: A.r, va: A.v, h: 30, aRel, omega: 1.2e-3, half: [vol.u, vol.v, vol.w] }), true);
});

// ---------------- pre-filter helpers ----------------
test('radius sampling: spacing and pad are consistent; circular LEO needs only sparse samples', () => {
  const K = radialCurvatureBound(6800, 0.001);
  const s = radiusSpacing(K, 2);
  assert.ok(Math.abs(radiusPad(K, s) - 2) < 1e-9);
  assert.ok(s > 200 && s < 400, `spacing ${s}`);
  assert.ok(radiusSpacing(radialCurvatureBound(7000, 0.7), 2) < 60); // HEO needs dense samples
});

test('shell counts equal brute force', () => {
  const rand = rng(21), N = 300;
  const rlo = new Float64Array(N), rhi = new Float64Array(N);
  for (let i = 0; i < N; i++) { rlo[i] = 6700 + rand() * 40000; rhi[i] = rlo[i]! + (rand() < 0.2 ? rand() * 30000 : rand() * 30); }
  const R = 67;
  const { perObject } = shellCounts(rlo, rhi, R);
  for (let i = 0; i < N; i++) {
    let c = 0;
    for (let j = 0; j < N; j++) if (rlo[j]! <= rhi[i]! + R && rhi[j]! >= rlo[i]! - R) c++;
    assert.equal(perObject[i], c);
  }
});

test('findMinima finds the closest approach of two constant-velocity bodies', () => {
  // r(t) = (-1000 + 15 t, 2, 0) km, t in s => minimum at t = 66.667 s
  const rel = (tMs: number) => ({ r: [-1000 + 15 * (tMs / 1000), 2, 0] as V3, v: [15, 0, 0] as V3 });
  const m = findMinima(rel, 0, 120_000, 5000, 0.01);
  assert.equal(m.length, 1);
  assert.ok(Math.abs(m[0]! - 66_666.67) < 1);
  assert.equal(findMinima(rel, 70_000, 120_000, 5000).length, 0); // minimum before the window
  void MU;
});
