// ============================================================
// SPIKE — not production. Worker half of the S6 screener (screen-s6.ts). Tasks:
//   init / bounds   per-object data (propagators, radius ranges, volumes)
//   radius          coarse SGP4 pass: measured radius range and top speed of each object (apogee-perigee pre-filter, bound inputs)
//   coarse          adaptive coarse stage: SGP4 every dt, spatial hash, the conservative window test of s6-lib.ts (THE BOUND)
//   formFrac        share of the window a pair spends within 50 km (formation exclusion, as S5)
//   refine6         per candidate run: sign changes of r.v on a fine grid, polished to 1 ms, volume test, Pc
//   refgrid/refine5 the reference: S5's 5 s grid and golden-section refine with a larger per-pair sphere (recall reference)
//   calls           real SGP4 call counter (read and reset)
// All positions TEME km.
// ============================================================
import { parentPort } from 'node:worker_threads';
import * as satellite from 'satellite.js';
import { makeProp, type Prop } from './runs.js';
import { classifyCa } from './events-ca.js';
import { evaluateEvent, evalCalls, type FwdEvent } from './forward-lib.js';
import type { CatFull } from './events.js';
import {
  MU, SFS_VOLUMES, inBox, inEllipsoid, windowCandidate, maxSeparation, relAccelBound, radialCurvatureBound, radiusSpacing, radiusPad, findMinima,
  ricBasis, toRic, type V3, type RelState,
} from './s6-lib.js';

let props: Array<Prop | null> = [];
let grp: Int32Array = new Int32Array(0);
let cats: CatFull[] = [];
let jumpSet = new Set<number>();
let sgp4Calls = 0;

// per-object bounds (set by 'bounds')
let rlo: Float64Array = new Float64Array(0), rhi: Float64Array = new Float64Array(0), vmax: Float64Array = new Float64Array(0), omega: Float64Array = new Float64Array(0);
let hu: Float64Array = new Float64Array(0), hv: Float64Array = new Float64Array(0), hw: Float64Array = new Float64Array(0), hr: Float64Array = new Float64Array(0);
let volId: Uint8Array = new Uint8Array(0);
let slowFlag: Uint8Array = new Uint8Array(0);
let sfsMode = true, sphereKm = 5;

let X = 0, Y = 0, Z = 0, VX = 0, VY = 0, VZ = 0;
/** One counted SGP4 call; fills the module scalars. False on failure. */
function ev(p: Prop, tMs: number): boolean {
  sgp4Calls++;
  const o = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = o ? o.position : null, v = o ? o.velocity : null;
  if (!r || !v || typeof r === 'boolean' || typeof v === 'boolean' || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.z) || !Number.isFinite(v.x)) return false;
  X = r.x; Y = r.y; Z = r.z; VX = v.x; VY = v.y; VZ = v.z;
  return true;
}

// ---------------- radius pass ----------------
export interface RadiusTask { type: 'radius'; o0: number; o1: number; t0Ms: number; t1Ms: number; padKm: number }
function radius(t: RadiusTask): Float64Array {
  const out = new Float64Array(6 * (t.o1 - t.o0)).fill(NaN);
  const T = (t.t1Ms - t.t0Ms) / 1000;
  for (let o = t.o0; o < t.o1; o++) {
    const p = props[o];
    const q = 6 * (o - t.o0);
    if (!p) continue;
    const omm = cats[o]!.omm;
    const n = Number(omm.MEAN_MOTION), e = Math.min(1, Math.max(0, Number(omm.ECCENTRICITY)));
    const a = Math.cbrt(MU / ((n * 2 * Math.PI) / 86400) ** 2);
    let K = radialCurvatureBound(Math.max(6300, 0.97 * a * (1 - e)), e);
    let s = Math.min(900, Math.max(15, radiusSpacing(K, t.padKm)));
    let rmin = Infinity, rmax = -Infinity, vm = 0, fail = 0, dt = s, samples = 0;
    for (let iter = 0; iter < 6; iter++) {
      const nS = Math.max(1, Math.ceil(T / s));
      dt = T / nS;
      rmin = Infinity; rmax = -Infinity; vm = 0; fail = 0; samples = nS + 1;
      for (let k = 0; k <= nS; k++) {
        if (!ev(p, t.t0Ms + k * dt * 1000)) { fail++; continue; }
        const r = Math.hypot(X, Y, Z), v = Math.hypot(VX, VY, VZ);
        if (r < rmin) rmin = r;
        if (r > rmax) rmax = r;
        if (v > vm) vm = v;
      }
      if (!(rmax > 0)) break;
      const eMeas = (rmax - rmin) / (rmax + rmin);
      K = radialCurvatureBound(Math.max(6300, rmin - 3), eMeas);
      const need = radiusSpacing(K, t.padKm);
      if (need >= dt * 0.999 || dt <= 15.001) break;
      s = Math.max(15, need * 0.95);
    }
    if (!(rmax > 0)) continue;
    const pad = radiusPad(K, dt);
    const lo = rmin - pad;
    out[q] = lo; out[q + 1] = rmax + pad;
    out[q + 2] = vm + K * (dt / 2); // |v| changes at most (mu/r^2) |rdot|/|v| <= (mu/r^2) e per second: the same curvature constant K as the radius
    out[q + 3] = samples; out[q + 4] = fail; out[q + 5] = pad;
  }
  return out;
}

// ---------------- spatial hash (as events-worker.ts) ----------------
const TABLE = 1 << 16;
const tx = new Int32Array(TABLE), ty = new Int32Array(TABLE), tz = new Int32Array(TABLE), thead = new Int32Array(TABLE);
const OFFS: Array<[number, number, number]> = [];
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
  if (dx > 0 || (dx === 0 && dy > 0) || (dx === 0 && dy === 0 && dz > 0)) OFFS.push([dx, dy, dz]);
}
const tx2 = new Int32Array(TABLE), ty2 = new Int32Array(TABLE), tz2 = new Int32Array(TABLE), thead2 = new Int32Array(TABLE);
const hash3 = (x: number, y: number, z: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (TABLE - 1);
function slotFind(x: number, y: number, z: number): number {
  let h = hash3(x, y, z);
  while (thead[h]! !== -1) { if (tx[h] === x && ty[h] === y && tz[h] === z) return h; h = (h + 1) & (TABLE - 1); }
  return -1;
}

// ---------------- coarse stage ----------------
export interface CoarseTask {
  type: 'coarse'; s0: number; s1: number; t0Ms: number; dtMs: number; subset: Int32Array;
  /** only pairs with at least one slow-class object (the slow pass); false = all pairs of the subset (the fast pass) */
  slowAny: boolean; L: number; h: number; epsCap: number; padCap: number; formEvery: number; formKm: number;
  /** fast movers: gathered against every object of the subset on a second grid with the larger cell Lh (their pairs are left out of the main grid) */
  hot?: Int32Array; Lh?: number; epsCapH?: number; padCapH?: number;
}
export interface CoarseOut { cand: Float64Array; form: Int32Array; tests: number; afterGather: number; afterShell: number; afterSegment: number; calls: number; ms: number }

function coarse(t: CoarseTask): CoarseOut {
  const t0 = performance.now(), calls0 = sgp4Calls;
  const N = props.length;
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N), vx = new Float64Array(N), vy = new Float64Array(N), vz = new Float64Array(N), rad = new Float64Array(N);
  const next = new Int32Array(N), cx = new Int32Array(N), cy = new Int32Array(N), cz = new Int32Array(N);
  const cand: number[] = [], form: number[] = [];
  const L2 = t.L * t.L, inv = 1 / t.L, h = t.h, f2 = t.formKm * t.formKm;
  let tests = 0, nGather = 0, nShell = 0, nSeg = 0;
  const sub = t.subset;
  const hot = t.hot ?? new Int32Array(0), isHot = new Uint8Array(N);
  for (const o of hot) isHot[o] = 1;
  const Lh = t.Lh ?? 1, invH = 1 / Lh, L2h = Lh * Lh;
  const hx = new Int32Array(N), hy = new Int32Array(N), hz = new Int32Array(N), hnext = new Int32Array(N);
  for (let s = t.s0; s < t.s1; s++) {
    const tMs = t.t0Ms + s * t.dtMs;
    const formStep = s % t.formEvery === 0;
    thead.fill(-1);
    if (hot.length) thead2.fill(-1);
    for (let k = 0; k < sub.length; k++) {
      const o = sub[k]!;
      cx[o] = 0x7fffffff;
      const p = props[o];
      if (!p || !ev(p, tMs)) continue;
      px[o] = X; py[o] = Y; pz[o] = Z; vx[o] = VX; vy[o] = VY; vz[o] = VZ; rad[o] = Math.hypot(X, Y, Z);
      if (hot.length) {
        // second grid (cell Lh) with every object, for the fast movers
        const jx = Math.floor(X * invH), jy = Math.floor(Y * invH), jz = Math.floor(Z * invH);
        hx[o] = jx; hy[o] = jy; hz[o] = jz;
        let q = hash3(jx, jy, jz);
        for (;;) {
          if (thead2[q] === -1) { tx2[q] = jx; ty2[q] = jy; tz2[q] = jz; hnext[o] = -1; thead2[q] = o; break; }
          if (tx2[q] === jx && ty2[q] === jy && tz2[q] === jz) { hnext[o] = thead2[q]!; thead2[q] = o; break; }
          q = (q + 1) & (TABLE - 1);
        }
        if (isHot[o]) { cx[o] = 0; continue; } // fast movers are not in the main grid (cx marks them valid)
      }
      const ix = Math.floor(X * inv), iy = Math.floor(Y * inv), iz = Math.floor(Z * inv);
      cx[o] = ix; cy[o] = iy; cz[o] = iz;
      let hh = hash3(ix, iy, iz);
      for (;;) {
        if (thead[hh] === -1) { tx[hh] = ix; ty[hh] = iy; tz[hh] = iz; next[o] = -1; thead[hh] = o; break; }
        if (tx[hh] === ix && ty[hh] === iy && tz[hh] === iz) { next[o] = thead[hh]!; thead[hh] = o; break; }
        hh = (hh + 1) & (TABLE - 1);
      }
    }
    const test = (i: number, j: number, L2: number, epsCap: number, padCap: number) => {
      if (t.slowAny && !slowFlag[i] && !slowFlag[j]) return;
      if (grp[i]! >= 0 && grp[i] === grp[j]) return;
      const dx = px[j]! - px[i]!, dy = py[j]! - py[i]!, dz = pz[j]! - pz[i]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      tests++;
      if (formStep && d2 <= f2) form.push(i < j ? i : j, i < j ? j : i);
      if (d2 > L2) return;
      nGather++;
      // apogee-perigee (shell) test with the measured radius ranges
      const R = hr[i]! > hr[j]! ? hr[i]! : hr[j]!;
      if (rlo[i]! - R > rhi[j]! || rlo[j]! - R > rhi[i]!) return;
      nShell++;
      const wx = vx[j]! - vx[i]!, wy = vy[j]! - vy[i]!, wz = vz[j]! - vz[i]!;
      const w2 = wx * wx + wy * wy + wz * wz;
      // closest approach of the straight segment over the window [-h, h]; must be within the largest widened volume
      let tc = 0;
      if (w2 > 1e-18) { tc = -(dx * wx + dy * wy + dz * wz) / w2; if (tc > h) tc = h; else if (tc < -h) tc = -h; }
      const mx = dx + wx * tc, my = dy + wy * tc, mz = dz + wz * tc;
      const cap = R + epsCap + padCap;
      if (mx * mx + my * my + mz * mz > cap * cap) return;
      nSeg++;
      const rF = Math.max(Math.min(rlo[i]!, rlo[j]!), Math.min(rad[i]! - vmax[i]! * h, rad[j]! - vmax[j]! * h));
      const D = maxSeparation(Math.sqrt(d2), Math.sqrt(w2), h, rF);
      const aRel = relAccelBound(D, rF);
      let ok = windowCandidate({ r: [dx, dy, dz], w: [wx, wy, wz], pa: [px[i]!, py[i]!, pz[i]!], va: [vx[i]!, vy[i]!, vz[i]!], h, aRel, omega: omega[i]!, half: [hu[i]!, hv[i]!, hw[i]!] });
      if (!ok) ok = windowCandidate({ r: [-dx, -dy, -dz], w: [-wx, -wy, -wz], pa: [px[j]!, py[j]!, pz[j]!], va: [vx[j]!, vy[j]!, vz[j]!], h, aRel, omega: omega[j]!, half: [hu[j]!, hv[j]!, hw[j]!] });
      if (ok) cand.push(i < j ? i : j, i < j ? j : i, s);
    };
    for (let k = 0; k < sub.length; k++) {
      const i = sub[k]!;
      if (cx[i] === 0x7fffffff || isHot[i]) continue;
      for (let j = next[i]!; j >= 0; j = next[j]!) test(i, j, L2, t.epsCap, t.padCap);
      for (let q = 0; q < OFFS.length; q++) {
        const o = OFFS[q]!;
        const hh = slotFind(cx[i]! + o[0], cy[i]! + o[1], cz[i]! + o[2]);
        if (hh < 0) continue;
        for (let j = thead[hh]!; j >= 0; j = next[j]!) test(i, j, L2, t.epsCap, t.padCap);
      }
    }
    for (let k = 0; k < hot.length; k++) {
      const i = hot[k]!;
      if (cx[i] === 0x7fffffff) continue;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        let q = hash3(hx[i]! + dx, hy[i]! + dy, hz[i]! + dz), found = -1;
        while (thead2[q]! !== -1) { if (tx2[q] === hx[i]! + dx && ty2[q] === hy[i]! + dy && tz2[q] === hz[i]! + dz) { found = q; break; } q = (q + 1) & (TABLE - 1); }
        if (found < 0) continue;
        for (let j = thead2[found]!; j >= 0; j = hnext[j]!) if (j !== i && (!isHot[j] || j > i)) test(i, j, L2h, t.epsCapH ?? t.epsCap, t.padCapH ?? t.padCap);
      }
    }
  }
  return { cand: Float64Array.from(cand), form: Int32Array.from(form), tests, afterGather: nGather, afterShell: nShell, afterSegment: nSeg, calls: sgp4Calls - calls0, ms: performance.now() - t0 };
}

// ---------------- formation fraction (as events-worker.ts) ----------------
export interface FormTask { type: 'formFrac'; pairs: Int32Array; t0Ms: number; t1Ms: number; stepMs: number; km: number; /** 0 = every step (S5); k > 0 = first look at every k-th step and only evaluate all steps when the share is within 0.3..0.7 */ stride?: number }
function dist(a: Prop, b: Prop, tm: number): number {
  if (!ev(a, tm)) return Infinity;
  const ax = X, ay = Y, az = Z;
  if (!ev(b, tm)) return Infinity;
  return Math.hypot(ax - X, ay - Y, az - Z);
}
function formFrac(t: FormTask): Float64Array {
  const out: number[] = [];
  const n = Math.floor((t.t1Ms - t.t0Ms) / t.stepMs);
  const k = t.stride ?? 0;
  for (let p = 0; p < t.pairs.length; p += 2) {
    const a = props[t.pairs[p]!]!, b = props[t.pairs[p + 1]!]!;
    let inside = 0, min = Infinity, m = 0;
    if (k > 1) {
      for (let q = 0; q < n; q += k) { const d = dist(a, b, t.t0Ms + q * t.stepMs); m++; if (d <= t.km) inside++; if (d < min) min = d; }
      const f = inside / m;
      if (f < 0.3 || f > 0.7) { out.push(t.pairs[p]!, t.pairs[p + 1]!, f, min); continue; }
      inside = 0; min = Infinity;
    }
    for (let q = 0; q < n; q++) { const d = dist(a, b, t.t0Ms + q * t.stepMs); if (d <= t.km) inside++; if (d < min) min = d; }
    out.push(t.pairs[p]!, t.pairs[p + 1]!, inside / n, min);
  }
  return Float64Array.from(out);
}

// ---------------- geometry of one pair at one time, volume tests ----------------
interface Geo { miss: number; vrel: number; ricB: V3; ricA: V3; inA: boolean; inB: boolean; ellA: boolean; ellB: boolean; in5: boolean; accepted: boolean }
const volOf = (o: number) => SFS_VOLUMES[volId[o]! - 1]!;
/** a and b are object indices (a = lower NORAD id by the caller's convention). ricB: b in a's frame; ricA: a in b's frame. */
function geometry(a: number, b: number, tMs: number): Geo | null {
  if (!ev(props[a]!, tMs)) return null;
  const ra: V3 = [X, Y, Z], va: V3 = [VX, VY, VZ];
  if (!ev(props[b]!, tMs)) return null;
  const rb: V3 = [X, Y, Z], vb: V3 = [VX, VY, VZ];
  const d: V3 = [rb[0] - ra[0], rb[1] - ra[1], rb[2] - ra[2]];
  const Ba = ricBasis(ra, va), Bb = ricBasis(rb, vb);
  if (!Ba || !Bb) return null;
  const ricB = toRic(d, Ba), ricA = toRic([-d[0], -d[1], -d[2]], Bb);
  const miss = Math.hypot(d[0], d[1], d[2]), vrel = Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]);
  const Va = volOf(a), Vb = volOf(b);
  const inA = inBox(ricB, Va), inB = inBox(ricA, Vb);
  const in5 = miss < 5;
  const accepted = (sfsMode && (inA || inB)) || (sphereKm > 0 && miss < sphereKm);
  return { miss, vrel, ricB, ricA, inA, inB, ellA: inEllipsoid(ricB, Va), ellB: inEllipsoid(ricA, Vb), in5, accepted };
}
const lite = (o: number) => { const c = cats[o]!; return { name: c.name, objectId: String(c.omm.OBJECT_ID), meanMotion: Number(c.omm.MEAN_MOTION), incDeg: Number(c.omm.INCLINATION), raanDeg: Number(c.omm.RA_OF_ASC_NODE) }; };

// ---------------- refine6 ----------------
export interface Refine6Task { type: 'refine6'; runs: Float64Array; pc: boolean }
export interface Refine6Out { events: FwdEvent[]; minima: number; accepted: number; evalFail: number; runs: number; subCalls: number }
function refine6(t: Refine6Task): Refine6Out {
  const events: FwdEvent[] = [];
  let minima = 0, accepted = 0, evalFail = 0;
  const c0 = sgp4Calls;
  for (let q = 0; q < t.runs.length; q += 5) {
    let a = t.runs[q]!, b = t.runs[q + 1]!;
    const ta = t.runs[q + 2]!, tb = t.runs[q + 3]!, sub = t.runs[q + 4]!;
    if (cats[a]!.noradId > cats[b]!.noradId) { const x = a; a = b; b = x; }
    const pa = props[a]!, pb = props[b]!;
    const rel = (tMs: number): RelState | null => {
      if (!ev(pa, tMs)) return null;
      const ax = X, ay = Y, az = Z, avx = VX, avy = VY, avz = VZ;
      if (!ev(pb, tMs)) return null;
      return { r: [X - ax, Y - ay, Z - az], v: [VX - avx, VY - avy, VZ - avz] };
    };
    for (const tca of findMinima(rel, ta, tb, sub, 1)) {
      minima++;
      const g = geometry(a, b, tca);
      if (!g || !g.accepted) continue;
      accepted++;
      const feat = classifyCa(lite(a), lite(b), g.miss, g.vrel);
      const e = evaluateEvent({ cat: cats[a]!, prop: pa }, { cat: cats[b]!, prop: pb }, tca, feat.cat, { jumpA: jumpSet.has(cats[a]!.noradId), jumpB: jumpSet.has(cats[b]!.noradId) });
      if (!e) { evalFail++; continue; }
      e.vol = { va: volId[a]!, vb: volId[b]!, inA: g.inA, inB: g.inB, ellA: g.ellA, ellB: g.ellB, in5: g.in5, ricB: g.ricA };
      events.push(e);
    }
  }
  return { events, minima, accepted, evalFail, runs: t.runs.length / 5, subCalls: sgp4Calls - c0 };
}

// ---------------- reference: S5's 5 s grid with a per-pair sphere, S5's refine ----------------
export interface RefGridTask {
  type: 'refgrid'; s0: number; s1: number; t0Ms: number; dtMs: number; L: number; slack: number; formEvery: number; formKm: number;
  /** keep a candidate only if its linear closest-approach point lies in either object's volume widened by pruneKm (0 = no pruning) */
  pruneKm: number;
}
export interface RefGridOut { cand: Float64Array; form: Int32Array; tests: number; ms: number }
function refgrid(t: RefGridTask): RefGridOut {
  const t0 = performance.now();
  const N = props.length;
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N), vx = new Float64Array(N), vy = new Float64Array(N), vz = new Float64Array(N);
  const next = new Int32Array(N), cx = new Int32Array(N), cy = new Int32Array(N), cz = new Int32Array(N);
  const cand: number[] = [], form: number[] = [];
  const L2 = t.L * t.L, inv = 1 / t.L, half = t.dtMs / 2000 + t.slack, f2 = t.formKm * t.formKm;
  let tests = 0;
  for (let s = t.s0; s < t.s1; s++) {
    const tMs = t.t0Ms + s * t.dtMs;
    const formStep = s % t.formEvery === 0;
    thead.fill(-1);
    for (let o = 0; o < N; o++) {
      cx[o] = 0x7fffffff;
      const p = props[o];
      if (!p || !ev(p, tMs)) continue;
      px[o] = X; py[o] = Y; pz[o] = Z; vx[o] = VX; vy[o] = VY; vz[o] = VZ;
      const ix = Math.floor(X * inv), iy = Math.floor(Y * inv), iz = Math.floor(Z * inv);
      cx[o] = ix; cy[o] = iy; cz[o] = iz;
      let h = hash3(ix, iy, iz);
      for (;;) {
        if (thead[h] === -1) { tx[h] = ix; ty[h] = iy; tz[h] = iz; next[o] = -1; thead[h] = o; break; }
        if (tx[h] === ix && ty[h] === iy && tz[h] === iz) { next[o] = thead[h]!; thead[h] = o; break; }
        h = (h + 1) & (TABLE - 1);
      }
    }
    const test = (i: number, j: number) => {
      if (grp[i]! >= 0 && grp[i] === grp[j]) return;
      const dx = px[i]! - px[j]!, dy = py[i]! - py[j]!, dz = pz[i]! - pz[j]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      tests++;
      if (formStep && d2 <= f2) form.push(i < j ? i : j, i < j ? j : i);
      if (d2 > L2) return;
      const wx = vx[i]! - vx[j]!, wy = vy[i]! - vy[j]!, wz = vz[i]! - vz[j]!;
      const v2 = wx * wx + wy * wy + wz * wz;
      let tau = 0, dl2 = d2;
      if (v2 > 1e-10) {
        const dot = dx * wx + dy * wy + dz * wz;
        tau = -dot / v2;
        if (tau > half || tau < -half) return;
        dl2 = d2 - (dot * dot) / v2;
      }
      const R = (hr[i]! > hr[j]! ? hr[i]! : hr[j]!) + 2;
      if (dl2 > R * R) return;
      if (t.pruneKm > 0) {
        // linear closest-approach vector of j relative to i, in i's frame, then j's frame for the swapped role
        const m: V3 = [-(dx + wx * tau), -(dy + wy * tau), -(dz + wz * tau)];
        const Bi = ricBasis([px[i]!, py[i]!, pz[i]!], [vx[i]!, vy[i]!, vz[i]!]), Bj = ricBasis([px[j]!, py[j]!, pz[j]!], [vx[j]!, vy[j]!, vz[j]!]);
        if (Bi && Bj) {
          const ri = toRic(m, Bi), rj = toRic([-m[0], -m[1], -m[2]], Bj), k = t.pruneKm;
          const okI = Math.abs(ri[0]) <= hu[i]! + k && Math.abs(ri[1]) <= hv[i]! + k && Math.abs(ri[2]) <= hw[i]! + k;
          const okJ = Math.abs(rj[0]) <= hu[j]! + k && Math.abs(rj[1]) <= hv[j]! + k && Math.abs(rj[2]) <= hw[j]! + k;
          if (!okI && !okJ) return;
        }
      }
      cand.push(i < j ? i : j, i < j ? j : i, s, tau, Math.sqrt(Math.max(0, dl2)));
    };
    for (let i = 0; i < N; i++) {
      if (cx[i] === 0x7fffffff) continue;
      for (let j = next[i]!; j >= 0; j = next[j]!) test(i, j);
      for (let k = 0; k < OFFS.length; k++) {
        const o = OFFS[k]!;
        const h = slotFind(cx[i]! + o[0], cy[i]! + o[1], cz[i]! + o[2]);
        if (h < 0) continue;
        for (let j = thead[h]!; j >= 0; j = next[j]!) test(i, j);
      }
    }
  }
  return { cand: Float64Array.from(cand), form: Int32Array.from(form), tests, ms: performance.now() - t0 };
}

const GR = 0.6180339887498949;
export interface Refine5Task { type: 'refine5'; buf: Float64Array; win: number }
/** Record: a, b (ordered by NORAD id), tca, miss, vrel, ricB(3), ricA(3), flags (bit0 inA, bit1 inB, bit2 in5, bit3 accepted). */
function refine5(t: Refine5Task): Float64Array {
  const out: number[] = [];
  for (let p = 0; p < t.buf.length; p += 3) {
    let i = t.buf[p]!, j = t.buf[p + 1]!;
    const tc = t.buf[p + 2]!;
    if (cats[i]!.noradId > cats[j]!.noradId) { const x = i; i = j; j = x; }
    const a = props[i]!, b = props[j]!;
    let best = Infinity, bt = tc;
    for (let q = -t.win; q <= t.win; q += 250) { const d = dist(a, b, tc + q); if (d < best) { best = d; bt = tc + q; } }
    let l = bt - 250, h = bt + 250;
    let x1 = h - GR * (h - l), x2 = l + GR * (h - l), f1 = dist(a, b, x1), f2 = dist(a, b, x2);
    for (let it = 0; it < 24; it++) {
      if (f1 < f2) { h = x2; x2 = x1; f2 = f1; x1 = h - GR * (h - l); f1 = dist(a, b, x1); }
      else { l = x1; x1 = x2; f1 = f2; x2 = l + GR * (h - l); f2 = dist(a, b, x2); }
    }
    const tb = f1 < f2 ? x1 : x2, db = Math.min(f1, f2);
    if (db < best) { best = db; bt = tb; }
    const g = geometry(i, j, bt);
    if (!g) continue;
    out.push(i, j, bt, g.miss, g.vrel, g.ricB[0], g.ricB[1], g.ricB[2], g.ricA[0], g.ricA[1], g.ricA[2], (g.inA ? 1 : 0) | (g.inB ? 2 : 0) | (g.in5 ? 4 : 0) | (g.accepted ? 8 : 0));
  }
  return Float64Array.from(out);
}

// ---------------- dispatcher ----------------
type Msg =
  | { type: 'init'; omm: Array<Record<string, unknown>>; group: Int32Array; cats: Array<Omit<CatFull, 'omm'>>; jumps: number[] }
  | { type: 'bounds'; rlo: Float64Array; rhi: Float64Array; vmax: Float64Array; omega: Float64Array; hu: Float64Array; hv: Float64Array; hw: Float64Array; hr: Float64Array; volId: Uint8Array; slow: Uint8Array; sfs: boolean; sphereKm: number }
  | RadiusTask | CoarseTask | FormTask | Refine6Task | RefGridTask | Refine5Task | { type: 'calls' };

parentPort!.on('message', (m: { id: number; msg: Msg }) => {
  const x = m.msg;
  let out: unknown = null;
  if (x.type === 'init') {
    props = x.omm.map((o) => makeProp(o));
    grp = x.group;
    cats = x.cats.map((c, i) => ({ ...c, omm: x.omm[i]! }) as CatFull);
    jumpSet = new Set(x.jumps);
  } else if (x.type === 'bounds') {
    rlo = x.rlo; rhi = x.rhi; vmax = x.vmax; omega = x.omega; hu = x.hu; hv = x.hv; hw = x.hw; hr = x.hr; volId = x.volId; slowFlag = x.slow; sfsMode = x.sfs; sphereKm = x.sphereKm;
  } else if (x.type === 'radius') out = radius(x);
  else if (x.type === 'coarse') out = coarse(x);
  else if (x.type === 'formFrac') out = formFrac(x);
  else if (x.type === 'refine6') out = refine6(x);
  else if (x.type === 'refgrid') out = refgrid(x);
  else if (x.type === 'refine5') out = refine5(x);
  else if (x.type === 'calls') { out = sgp4Calls + evalCalls.n; sgp4Calls = 0; evalCalls.n = 0; }
  parentPort!.postMessage({ id: m.id, out });
});
