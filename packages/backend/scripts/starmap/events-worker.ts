// ============================================================
// SPIKE — not production. Worker half of derive-day.ts: close-approach grid steps, refinement,
// formation fractions and region passes. SGP4 only; all positions TEME km.
// ============================================================
import { parentPort } from 'node:worker_threads';
import * as satellite from 'satellite.js';
import { makeProp, type Prop } from './runs.js';
import { gmst, regionMask, lastLL, chordNeedsWalk } from './events.js';
import type { InitMsg } from './events-pool.js';
import { scanRegions } from './events-region.js';

let props: Array<Prop | null> = [];
let grp: Int32Array;

// ---------------- spatial hash grid (as screen-worker.ts, plus velocities) ----------------
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

export interface CaTask { type: 'ca'; s0: number; s1: number; t0Ms: number; dtMs: number; L: number; thr: number; slack: number; formEvery: number; formKm: number }
export interface CaOut { cand: Float64Array; form: Int32Array; tests: number; ms: number }

function ca(t: CaTask): CaOut {
  const t0 = performance.now();
  const N = props.length;
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N);
  const vx = new Float64Array(N), vy = new Float64Array(N), vz = new Float64Array(N);
  const next = new Int32Array(N), cx = new Int32Array(N), cy = new Int32Array(N), cz = new Int32Array(N);
  const cand: number[] = [], form: number[] = [];
  const L2 = t.L * t.L, inv = 1 / t.L, half = t.dtMs / 2000 + t.slack, thr2 = (t.thr + 2) * (t.thr + 2), f2 = t.formKm * t.formKm;
  let tests = 0;
  for (let s = t.s0; s < t.s1; s++) {
    const tMs = t.t0Ms + s * t.dtMs;
    const formStep = s % t.formEvery === 0;
    thead.fill(-1);
    for (let o = 0; o < N; o++) {
      const p = props[o];
      let ok = false;
      if (p) {
        const pv = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
        const r = pv ? pv.position : null, v = pv ? pv.velocity : null;
        if (r && v && typeof r !== 'boolean' && typeof v !== 'boolean' && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z) && Number.isFinite(v.x)) {
          px[o] = r.x; py[o] = r.y; pz[o] = r.z; vx[o] = v.x; vy[o] = v.y; vz[o] = v.z; ok = true;
        }
      }
      if (!ok) { cx[o] = 0x7fffffff; continue; }
      const ix = Math.floor(px[o]! * inv), iy = Math.floor(py[o]! * inv), iz = Math.floor(pz[o]! * inv);
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
      if (dl2 <= thr2) cand.push(i < j ? i : j, i < j ? j : i, s, tau, Math.sqrt(Math.max(0, dl2)));
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

// ---------------- refine: exact TCA by 0.25 s scan + golden section ----------------
const GR = 0.6180339887498949;
export interface RefineTask { type: 'refine'; buf: Float64Array; win: number }
function dist(a: Prop, b: Prop, tm: number): { d: number; v: number } {
  const pa = satellite.sgp4(a.satrec, (tm - a.epochMs) / 60_000), pb = satellite.sgp4(b.satrec, (tm - b.epochMs) / 60_000);
  const ra = pa ? pa.position : null, rb = pb ? pb.position : null, va = pa ? pa.velocity : null, vb = pb ? pb.velocity : null;
  if (!ra || !rb || !va || !vb || typeof ra === 'boolean' || typeof rb === 'boolean' || typeof va === 'boolean' || typeof vb === 'boolean') return { d: Infinity, v: 0 };
  return { d: Math.hypot(ra.x - rb.x, ra.y - rb.y, ra.z - rb.z), v: Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z) };
}
function refine(t: RefineTask): Float64Array {
  const out: number[] = [];
  for (let p = 0; p < t.buf.length; p += 3) {
    const i = t.buf[p]!, j = t.buf[p + 1]!, tc = t.buf[p + 2]!;
    const a = props[i]!, b = props[j]!;
    let best = Infinity, bt = tc;
    for (let q = -t.win; q <= t.win; q += 250) { const d = dist(a, b, tc + q).d; if (d < best) { best = d; bt = tc + q; } }
    let l = bt - 250, h = bt + 250;
    let x1 = h - GR * (h - l), x2 = l + GR * (h - l), f1 = dist(a, b, x1).d, f2 = dist(a, b, x2).d;
    for (let it = 0; it < 24; it++) {
      if (f1 < f2) { h = x2; x2 = x1; f2 = f1; x1 = h - GR * (h - l); f1 = dist(a, b, x1).d; }
      else { l = x1; x1 = x2; f1 = f2; x2 = l + GR * (h - l); f2 = dist(a, b, x2).d; }
    }
    const tb = f1 < f2 ? x1 : x2, db = Math.min(f1, f2);
    if (db < best) { best = db; bt = tb; }
    out.push(i, j, best, bt, dist(a, b, bt).v);
  }
  return Float64Array.from(out);
}

// ---------------- formation fraction ----------------
export interface FormTask { type: 'formFrac'; pairs: Int32Array; t0Ms: number; t1Ms: number; stepMs: number; km: number }
function formFrac(t: FormTask): Float64Array {
  const out: number[] = [];
  const n = Math.floor((t.t1Ms - t.t0Ms) / t.stepMs);
  for (let p = 0; p < t.pairs.length; p += 2) {
    const a = props[t.pairs[p]!]!, b = props[t.pairs[p + 1]!]!;
    let inside = 0, min = Infinity;
    for (let k = 0; k < n; k++) {
      const d = dist(a, b, t.t0Ms + k * t.stepMs).d;
      if (d <= t.km) inside++;
      if (d < min) min = d;
    }
    out.push(t.pairs[p]!, t.pairs[p + 1]!, inside / n, min);
  }
  return Float64Array.from(out);
}

// ---------------- region passes ----------------
export interface RegionTask { type: 'region'; o0: number; o1: number; idx?: Int32Array; t0Ms: number; t1Ms: number; stepMs: number }
function maskAt(p: Prop, tMs: number, theta?: number): number {
  const pv = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = pv ? pv.position : null;
  if (!r || typeof r === 'boolean' || !Number.isFinite(r.x)) return 0;
  return regionMask(theta ?? gmst(tMs), r.x, r.y, r.z, false);
}
function region(t: RegionTask): Float64Array {
  const out: number[] = [];
  const stats = { samples: 0 };
  const geo = { ll: (o: Float64Array) => { o[0] = lastLL[0]!; o[1] = lastLL[1]!; }, chord: (a: Float64Array, b: Float64Array) => chordNeedsWalk(a, b) };
  for (let oi = t.o0; oi < t.o1; oi++) {
    const o = t.idx ? t.idx[oi]! : oi;
    const p = props[o];
    if (!p) continue;
    stats.samples += scanRegions(o, (tm) => maskAt(p, tm), t.t0Ms, t.t1Ms, t.stepMs, 1000, out, undefined, geo).samples;
  }
  return Float64Array.from(out);
}

type Msg = InitMsg | CaTask | RefineTask | FormTask | RegionTask;
parentPort!.on('message', (m: { id: number; msg: Msg }) => {
  const x = m.msg;
  let out: unknown = null;
  if (x.type === 'init') { props = x.omm.map((o) => makeProp(o)); grp = x.group; }
  else if (x.type === 'ca') out = ca(x);
  else if (x.type === 'refine') out = refine(x);
  else if (x.type === 'formFrac') out = formFrac(x);
  else if (x.type === 'region') out = region(x);
  parentPort!.postMessage({ id: m.id, out });
});
