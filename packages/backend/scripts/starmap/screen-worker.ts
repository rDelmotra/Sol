// ============================================================
// SPIKE — not production. Screening worker: SGP4 propagation into shared memory, spatial-hash grid,
// sort-and-sweep sieves with MOID, and 1 s + golden-section refinement of candidate pairs.
// ============================================================
import { parentPort } from 'node:worker_threads';
import * as satellite from 'satellite.js';
import { makeProp, type Prop } from './runs.js';
import { moidPacked, COARSE_N } from './moid.js';
import type { InitMsg, SharedLayout, Task, GridOut, SieveOut, RefineOut, IssOut } from './screen-types.js';

let props: Array<Prop | null> = [];
let S: SharedLayout;
let pos: Float32Array, lo: Float64Array, hi: Float64Array, ord: Int32Array, loS: Float64Array, hiS: Float64Array;
let wires: Float64Array, samples: Float64Array, pad1: Float64Array;
const SAMPLE_LEN = COARSE_N * 3;

function sgp(p: Prop, tMs: number, out: Float64Array, o: number): boolean {
  const pv = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = pv ? pv.position : null;
  if (!r || typeof r === 'boolean' || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.z)) return false;
  out[o] = r.x; out[o + 1] = r.y; out[o + 2] = r.z;
  return true;
}

function init(m: InitMsg): void {
  props = m.omm.map((o) => makeProp(o));
  S = m.shared;
  pos = new Float32Array(S.pos); lo = new Float64Array(S.lo); hi = new Float64Array(S.hi);
  ord = new Int32Array(S.ord); loS = new Float64Array(S.loS); hiS = new Float64Array(S.hiS);
  wires = new Float64Array(S.wires); samples = new Float64Array(S.samples); pad1 = new Float64Array(S.pad1);
}

function fill(t: { o0: number; o1: number }): number {
  const tmp = new Float64Array(3);
  const ns = S.nSteps;
  for (let o = t.o0; o < t.o1; o++) {
    const p = props[o];
    for (let s = 0; s < ns; s++) {
      const b = (o * ns + s) * 3;
      if (p && sgp(p, S.t0Ms + s * S.dtMs, tmp, 0)) { pos[b] = tmp[0]!; pos[b + 1] = tmp[1]!; pos[b + 2] = tmp[2]!; }
      else { pos[b] = NaN; pos[b + 1] = NaN; pos[b + 2] = NaN; }
    }
  }
  return 0;
}

// ---------------- spatial hash grid ----------------
const TABLE = 1 << 16;
const tx = new Int32Array(TABLE), ty = new Int32Array(TABLE), tz = new Int32Array(TABLE), thead = new Int32Array(TABLE);
const OFFS: Array<[number, number, number]> = [];
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
  if (dx > 0 || (dx === 0 && dy > 0) || (dx === 0 && dy === 0 && dz > 0)) OFFS.push([dx, dy, dz]);
}
const hash3 = (x: number, y: number, z: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (TABLE - 1);

function slotFind(x: number, y: number, z: number): number {
  let h = hash3(x, y, z);
  while (thead[h]! !== -1) {
    if (tx[h] === x && ty[h] === y && tz[h] === z) return h;
    h = (h + 1) & (TABLE - 1);
  }
  return -1;
}

function grid(t: Extract<Task, { type: 'grid' }>): GridOut {
  const t0 = performance.now();
  const N = S.n, ns = S.nSteps;
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N);
  const next = new Int32Array(N), cx = new Int32Array(N), cy = new Int32Array(N), cz = new Int32Array(N);
  const out: number[] = [];
  const D2 = t.D * t.D, inv = 1 / t.L;
  let tests = 0, skipped = 0, cand = 0;
  for (let s = t.s0; s < t.s1; s += t.stride) {
    thead.fill(-1);
    for (let o = 0; o < N; o++) {
      const b = (o * ns + s) * 3;
      const x = pos[b]!, y = pos[b + 1]!, z = pos[b + 2]!;
      px[o] = x; py[o] = y; pz[o] = z;
      if (!(x === x)) { cx[o] = 0x7fffffff; continue; }
      const ix = Math.floor(x * inv), iy = Math.floor(y * inv), iz = Math.floor(z * inv);
      cx[o] = ix; cy[o] = iy; cz[o] = iz;
      let h = hash3(ix, iy, iz);
      for (;;) {
        if (thead[h] === -1) { tx[h] = ix; ty[h] = iy; tz[h] = iz; next[o] = -1; thead[h] = o; break; }
        if (tx[h] === ix && ty[h] === iy && tz[h] === iz) { next[o] = thead[h]!; thead[h] = o; break; }
        h = (h + 1) & (TABLE - 1);
      }
    }
    const test = (i: number, j: number) => {
      if (t.hybrid) {
        if (lo[i]! > hi[j]! + t.gap || lo[j]! > hi[i]! + t.gap) { skipped++; return; }
      }
      tests++;
      const dx = px[i]! - px[j]!, dy = py[i]! - py[j]!, dz = pz[i]! - pz[j]!;
      if (dx * dx + dy * dy + dz * dz <= D2) { cand++; out.push(i < j ? i : j, i < j ? j : i, s); }
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
  return { trip: Int32Array.from(out), tests, skipped, cand, ms: performance.now() - t0 };
}

// ---------------- sieves ----------------
/** Deterministic pair sampling (main thread uses the same rule to restrict the reference). */
function inSample(i: number, j: number, k: number): boolean {
  const a = i < j ? i : j, b = i < j ? j : i;
  return ((Math.imul(a, 2654435761) ^ Math.imul(b, 40503)) >>> 0) % k === 0;
}
function sieve(t: Extract<Task, { type: 'sieve' }>): SieveOut {
  const N = S.n, ns = S.nSteps;
  const out: number[] = [];
  let n0 = 0, n1 = 0, msEnum = 0, msMoid = 0, msScan = 0;
  const D2 = t.D * t.D;
  const bi: number[] = [], bj: number[] = [];
  for (let u = t.u0; u < t.u1; u++) {
    const i = ord[u]!;
    const lim = hiS[u]! + t.gap;
    const ta = performance.now();
    bi.length = 0; bj.length = 0;
    for (let v = u + 1; v < N && loS[v]! <= lim; v++) {
      n0++;
      const j = ord[v]!;
      if (t.sampleEvery > 1 && !inSample(i, j, t.sampleEvery)) continue;
      bi.push(i); bj.push(j);
    }
    msEnum += performance.now() - ta;
    if (!t.moid) continue;
    const tb = performance.now();
    const keep: number[] = [];
    for (let k = 0; k < bi.length; k++) {
      const a = bi[k]!, b = bj[k]!;
      const lim = t.gap + pad1[a]! + pad1[b]!;
      const m = moidPacked(wires, a * 9, samples, a * SAMPLE_LEN, wires, b * 9, samples, b * SAMPLE_LEN, t.earlyExit ? lim : -1).dist;
      if (m <= lim) keep.push(k);
    }
    msMoid += performance.now() - tb;
    n1 += keep.length;
    if (!t.scan) continue;
    const tc = performance.now();
    for (const k of keep) {
      const a = bi[k]!, b = bj[k]!;
      const A = a * ns * 3, B = b * ns * 3;
      for (let s = 0; s < ns; s++) {
        const dx = pos[A + s * 3]! - pos[B + s * 3]!, dy = pos[A + s * 3 + 1]! - pos[B + s * 3 + 1]!, dz = pos[A + s * 3 + 2]! - pos[B + s * 3 + 2]!;
        if (dx * dx + dy * dy + dz * dz <= D2) out.push(a < b ? a : b, a < b ? b : a, s);
      }
    }
    msScan += performance.now() - tc;
  }
  return { trip: Int32Array.from(out), n0, n1, msEnum, msMoid, msScan };
}

// ---------------- refine ----------------
const GR = 0.6180339887498949;
function refine(t: Extract<Task, { type: 'refine' }>): RefineOut {
  const t0 = performance.now();
  const buf = t.buf;
  const res: number[] = [];
  const A = new Float64Array(3), B = new Float64Array(3);
  const tStart = S.t0Ms, tEnd = S.t0Ms + (S.nSteps - 1) * S.dtMs;
  const half = (t.stride * S.dtMs) / 2;
  let p = 0;
  while (p < buf.length) {
    const i = buf[p]!, j = buf[p + 1]!, k = buf[p + 2]!;
    const pa = props[i]!, pb = props[j]!;
    const dist = (tm: number) => {
      if (!sgp(pa, tm, A, 0) || !sgp(pb, tm, B, 0)) return Infinity;
      return Math.hypot(A[0]! - B[0]!, A[1]! - B[1]!, A[2]! - B[2]!);
    };
    let best = Infinity, bestT = 0, lastSec = -1;
    for (let q = 0; q < k; q++) {
      const ts = S.t0Ms + buf[p + 3 + q]! * S.dtMs;
      const a = Math.max(tStart, ts - half - 1000), b = Math.min(tEnd, ts + half + 1000);
      let sec = Math.max(Math.ceil((a - tStart) / 1000), lastSec + 1);
      const secEnd = Math.floor((b - tStart) / 1000);
      for (; sec <= secEnd; sec++) {
        const tm = tStart + sec * 1000;
        const d = dist(tm);
        if (d < best) { best = d; bestT = tm; }
        lastSec = sec;
      }
    }
    if (best < Infinity) {
      let l = Math.max(tStart, bestT - 1000), h = Math.min(tEnd, bestT + 1000);
      let x1 = h - GR * (h - l), x2 = l + GR * (h - l), f1 = dist(x1), f2 = dist(x2);
      for (let it = 0; it < 28; it++) {
        if (f1 < f2) { h = x2; x2 = x1; f2 = f1; x1 = h - GR * (h - l); f1 = dist(x1); }
        else { l = x1; x1 = x2; f1 = f2; x2 = l + GR * (h - l); f2 = dist(x2); }
      }
      if (f1 < best) { best = f1; bestT = x1; }
      if (f2 < best) { best = f2; bestT = x2; }
    }
    res.push(i, j, best, bestT);
    p += 3 + k;
  }
  return { res: Float64Array.from(res), ms: performance.now() - t0 };
}

function issScan(t: Extract<Task, { type: 'issScan' }>): IssOut {
  const res: number[] = [];
  const tmp = new Float64Array(3);
  for (const o of t.idx) {
    const p = props[o]!;
    let best = Infinity, bk = -1;
    for (let k = 0; k < t.nIss; k++) {
      if (!sgp(p, S.t0Ms + k * t.stepMs, tmp, 0)) continue;
      const dx = tmp[0]! - t.iss[k * 3]!, dy = tmp[1]! - t.iss[k * 3 + 1]!, dz = tmp[2]! - t.iss[k * 3 + 2]!;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; bk = k; }
    }
    res.push(o, Math.sqrt(best), bk);
  }
  return { res: Float64Array.from(res) };
}

/** Time filter: SGP4 every coarseS seconds with a relative-motion pad, then 1 s only around the hits. */
function issCoarse(t: Extract<Task, { type: 'issCoarse' }>): IssOut & { evals: number } {
  const res: number[] = [];
  const tmp = new Float64Array(3);
  const c = t.coarseS, thr = t.R + (t.vmax * c) / 2 + 1;
  let evals = 0;
  for (const o of t.idx) {
    const p = props[o]!;
    let best = Infinity, bk = -1, last = -1;
    for (let k = 0; k < t.nIss; k += c) {
      evals++;
      if (!sgp(p, S.t0Ms + k * 1000, tmp, 0)) continue;
      const d = Math.hypot(tmp[0]! - t.iss[k * 3]!, tmp[1]! - t.iss[k * 3 + 1]!, tmp[2]! - t.iss[k * 3 + 2]!);
      if (d > thr) continue;
      const a = Math.max(0, k - Math.ceil(c / 2) - 1, last + 1), b = Math.min(t.nIss - 1, k + Math.ceil(c / 2) + 1);
      for (let q = a; q <= b; q++) {
        evals++;
        if (!sgp(p, S.t0Ms + q * 1000, tmp, 0)) continue;
        const dd = Math.hypot(tmp[0]! - t.iss[q * 3]!, tmp[1]! - t.iss[q * 3 + 1]!, tmp[2]! - t.iss[q * 3 + 2]!);
        if (dd < best) { best = dd; bk = q; }
      }
      last = b;
    }
    res.push(o, best, bk);
  }
  return { res: Float64Array.from(res), evals };
}

parentPort!.on('message', (m: { id: number; msg: InitMsg | Task }) => {
  const x = m.msg;
  let out: unknown = null;
  if (x.type === 'init') init(x);
  else if (x.type === 'fill') out = fill(x);
  else if (x.type === 'grid') out = grid(x);
  else if (x.type === 'sieve') out = sieve(x);
  else if (x.type === 'refine') out = refine(x);
  else if (x.type === 'issScan') out = issScan(x);
  else if (x.type === 'issCoarse') out = issCoarse(x);
  parentPort!.postMessage({ id: m.id, out });
});
