// ============================================================
// SPIKE — not production.
//
// "Day lines": one object's whole path for one UTC day stored as piecewise
// Chebyshev polynomials (same idea as NASA SPICE SPK type 2/3). Positions only
// (x,y,z in TEME km); velocity is the analytic derivative.
//
// Binary layout (little endian), 12-byte header:
//   u8  version (1)
//   u8  flags   (bit0: 1 = float32 tail coefficients, 0 = all float64)
//   u8  degree
//   u8  reserved
//   u16 nseg
//   u16 marginSec   (coverage is [dayStart - margin, dayStart + 86400 + margin])
//   u32 dayStartSec (unix seconds)
// then per segment, per axis (x,y,z): a0..a_deg, with p(x) = sum a_j T_j(x), x in [-1,1].
//   f64 mode: (deg+1) float64 per axis.
//   f32 mode: a0 as float64, then deg float32 (the tail is small relative to the
//             constant term, and its rounding error is checked inside the fit).
// ============================================================

export const HEADER_BYTES = 12;
const FLAG_F32 = 1;
export type Precision = 'f64' | 'f32';
export type SampleFn = (tMs: number) => readonly [number, number, number] | null;

export interface FitOpts {
  /** Max position error, km, on the dense check grid. */
  tolKm?: number;
  /** Extra coverage on each side of the day, seconds. */
  marginSec?: number;
  precision?: Precision;
  /** Verification grid step, seconds (default 10). */
  checkStepSec?: number;
  /** Reject fits larger than this many bytes. */
  maxBytes?: number;
  /** Degrees tried (ascending). */
  degrees?: number[];
}

export interface DayLine {
  buf: Uint8Array;
  nseg: number;
  deg: number;
  maxErrKm: number;
}
export type FitFailure = { fail: 'sample-failed' | 'no-fit' | 'oversize'; detail?: string };

const NSEG_CANDIDATES = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 128, 160, 192, 256, 384, 512];
const DEG_CANDIDATES = [6, 9, 12, 16, 20, 24, 30];
const DAY_S = 86400;

export const bytesFor = (nseg: number, deg: number, p: Precision): number =>
  HEADER_BYTES + nseg * 3 * (p === 'f64' ? (deg + 1) * 8 : 8 + deg * 4);

// ---------- Chebyshev primitives ----------

/** a[j] for interpolation at the N=deg+1 Chebyshev nodes; f[k] sampled at x_k = cos(pi (k+.5)/N). */
function chebCoeffs(f: Float64Array, N: number, out: Float64Array, o: number, cosTab: Float64Array): void {
  for (let j = 0; j < N; j++) {
    let s = 0;
    const row = j * N;
    for (let k = 0; k < N; k++) s += f[k]! * cosTab[row + k]!;
    out[o + j] = j === 0 ? s / N : (2 * s) / N;
  }
}
const cosCache = new Map<number, Float64Array>();
function cosTable(N: number): Float64Array {
  let t = cosCache.get(N);
  if (!t) {
    t = new Float64Array(N * N);
    for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) t[j * N + k] = Math.cos((Math.PI * j * (k + 0.5)) / N);
    cosCache.set(N, t);
  }
  return t;
}

/** Clenshaw evaluation of sum a_j T_j(x) on coef[o .. o+N). */
export function clenshaw(c: Float64Array, o: number, N: number, x: number): number {
  let b1 = 0, b2 = 0;
  const x2 = 2 * x;
  for (let j = N - 1; j >= 1; j--) {
    const b = x2 * b1 - b2 + c[o + j]!;
    b2 = b1;
    b1 = b;
  }
  return x * b1 - b2 + c[o]!;
}
/** d/dx of the series, by direct T/U recurrence. T_j' = j U_{j-1}. */
export function chebDeriv(c: Float64Array, o: number, N: number, x: number): number {
  let u0 = 1, u1 = 2 * x; // U0, U1
  let s = c[o + 1]! * 1; // j=1: 1*U0
  for (let j = 2; j < N; j++) {
    s += c[o + j]! * j * u1;
    const u2 = 2 * x * u1 - u0;
    u0 = u1;
    u1 = u2;
  }
  return s;
}

// ---------- fitting ----------

interface Truth { t0: number; step: number; n: number; xyz: Float64Array }

function sampleTruth(fn: SampleFn, t0: number, t1: number, stepMs: number): Truth | null {
  const n = Math.round((t1 - t0) / stepMs) + 1;
  const xyz = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = fn(t0 + i * stepMs);
    if (!p) return null;
    xyz[i * 3] = p[0]; xyz[i * 3 + 1] = p[1]; xyz[i * 3 + 2] = p[2];
  }
  return { t0, step: stepMs, n, xyz };
}

interface Fitted { coef: Float64Array; nseg: number; N: number }

/** Fit nseg equal segments of degree deg over [t0,t1]; null if the sampler fails. Coefs are quantised for f32 mode. */
function fitSegments(fn: SampleFn, t0: number, t1: number, nseg: number, deg: number, prec: Precision): Fitted | null {
  const N = deg + 1;
  const len = (t1 - t0) / nseg;
  const ct = cosTable(N);
  const xs = new Float64Array(N);
  for (let k = 0; k < N; k++) xs[k] = Math.cos((Math.PI * (k + 0.5)) / N);
  const coef = new Float64Array(nseg * 3 * N);
  const f = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  for (let s = 0; s < nseg; s++) {
    const a = t0 + s * len;
    for (let k = 0; k < N; k++) {
      const p = fn(a + ((xs[k]! + 1) / 2) * len);
      if (!p) return null;
      f[0]![k] = p[0]; f[1]![k] = p[1]; f[2]![k] = p[2];
    }
    for (let ax = 0; ax < 3; ax++) {
      const o = (s * 3 + ax) * N;
      chebCoeffs(f[ax]!, N, coef, o, ct);
      if (prec === 'f32') for (let j = 1; j < N; j++) coef[o + j] = Math.fround(coef[o + j]!);
    }
  }
  return { coef, nseg, N };
}

/** Max position error of the fit vs truth samples taken every `stride` truth points. */
function maxError(fit: Fitted, t0: number, t1: number, tr: Truth, stride: number): number {
  const { coef, nseg, N } = fit;
  const len = (t1 - t0) / nseg;
  let worst = 0;
  for (let i = 0; i < tr.n; i += stride) {
    const t = tr.t0 + i * tr.step;
    let s = Math.floor((t - t0) / len);
    if (s >= nseg) s = nseg - 1;
    if (s < 0) s = 0;
    const x = (2 * (t - (t0 + s * len))) / len - 1;
    const o = s * 3 * N;
    const dx = clenshaw(coef, o, N, x) - tr.xyz[i * 3]!;
    const dy = clenshaw(coef, o + N, N, x) - tr.xyz[i * 3 + 1]!;
    const dz = clenshaw(coef, o + 2 * N, N, x) - tr.xyz[i * 3 + 2]!;
    const e = Math.hypot(dx, dy, dz);
    if (e > worst) worst = e;
  }
  return worst;
}

export function encodeFit(fit: Fitted, deg: number, dayStartMs: number, marginSec: number, prec: Precision): Uint8Array {
  const { coef, nseg, N } = fit;
  const out = new Uint8Array(bytesFor(nseg, deg, prec));
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 1);
  dv.setUint8(1, prec === 'f32' ? FLAG_F32 : 0);
  dv.setUint8(2, deg);
  dv.setUint16(4, nseg, true);
  dv.setUint16(6, marginSec, true);
  dv.setUint32(8, Math.round(dayStartMs / 1000), true);
  let p = HEADER_BYTES;
  for (let r = 0; r < nseg * 3; r++) {
    const o = r * N;
    for (let j = 0; j < N; j++) {
      if (prec === 'f64' || j === 0) { dv.setFloat64(p, coef[o + j]!, true); p += 8; }
      else { dv.setFloat32(p, coef[o + j]!, true); p += 4; }
    }
  }
  return out;
}

/**
 * Cover [dayStart-margin, dayStart+24h+margin] with equal segments; pick (nseg,deg) minimising bytes
 * subject to max position error <= tolKm on the dense check grid. Search runs on a 6x coarser grid
 * and the winner is verified (and bumped to more segments if needed) on the full grid.
 */
export function fitDayLine(sample: SampleFn, dayStartMs: number, opts: FitOpts = {}): DayLine | FitFailure {
  const tol = opts.tolKm ?? 0.1;
  const margin = opts.marginSec ?? 0;
  const prec = opts.precision ?? 'f64';
  const checkStep = (opts.checkStepSec ?? 10) * 1000;
  const maxBytes = opts.maxBytes ?? 65536;
  const degs = opts.degrees ?? DEG_CANDIDATES;
  const t0 = dayStartMs - margin * 1000;
  const t1 = dayStartMs + (DAY_S + margin) * 1000;
  const tr = sampleTruth(sample, t0, t1, checkStep);
  if (!tr) return { fail: 'sample-failed' };
  const COARSE = 6;

  let best: { nseg: number; deg: number; bytes: number } | null = null;
  let bestFit: Fitted | null = null;
  const ok = (nseg: number, deg: number, stride: number): Fitted | null | false => {
    const f = fitSegments(sample, t0, t1, nseg, deg, prec);
    if (!f) return null;
    return maxError(f, t0, t1, tr, stride) <= tol ? f : false;
  };
  for (const deg of degs) {
    if (best && bytesFor(1, deg, prec) >= best.bytes) continue;
    // smallest nseg index (monotone assumption) meeting tol on the coarse grid
    let lo = 0, hi = NSEG_CANDIDATES.length - 1;
    // cap by size: skip nseg that already exceed current best
    while (hi > 0 && best && bytesFor(NSEG_CANDIDATES[hi]!, deg, prec) >= best.bytes) hi--;
    if (best && bytesFor(NSEG_CANDIDATES[hi]!, deg, prec) >= best.bytes) continue;
    const top = ok(NSEG_CANDIDATES[hi]!, deg, COARSE);
    if (top === null) return { fail: 'sample-failed' };
    if (top === false) continue;
    let found = hi; let foundFit: Fitted = top;
    hi = hi - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ok(NSEG_CANDIDATES[mid]!, deg, COARSE);
      if (r === null) return { fail: 'sample-failed' };
      if (r) { found = mid; foundFit = r; hi = mid - 1; } else lo = mid + 1;
    }
    const nseg = NSEG_CANDIDATES[found]!;
    const bytes = bytesFor(nseg, deg, prec);
    if (!best || bytes < best.bytes) { best = { nseg, deg, bytes }; bestFit = foundFit; }
  }
  if (!best || !bestFit) return { fail: 'no-fit' };

  // Verify on the full grid; if the coarse search was optimistic, step up nseg until it passes.
  let idx = NSEG_CANDIDATES.indexOf(best.nseg);
  let fit: Fitted = bestFit;
  let err = maxError(fit, t0, t1, tr, 1);
  while (err > tol && idx < NSEG_CANDIDATES.length - 1) {
    idx++;
    const f = fitSegments(sample, t0, t1, NSEG_CANDIDATES[idx]!, best.deg, prec);
    if (!f) return { fail: 'sample-failed' };
    fit = f;
    err = maxError(fit, t0, t1, tr, 1);
  }
  if (err > tol) return { fail: 'no-fit', detail: `err ${err.toFixed(3)} km` };
  const bytes = bytesFor(fit.nseg, best.deg, prec);
  if (bytes > maxBytes) return { fail: 'oversize', detail: `${bytes} B` };
  return { buf: encodeFit(fit, best.deg, dayStartMs, margin, prec), nseg: fit.nseg, deg: best.deg, maxErrKm: err };
}

// ---------- decoding / evaluation ----------

export interface Decoded {
  deg: number;
  nseg: number;
  /** coverage start, ms */
  t0: number;
  /** segment length, ms */
  len: number;
  /** all coefficients as float64, [seg][axis][j] */
  coef: Float64Array;
}

export function decodeDayLine(buf: Uint8Array): Decoded {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint8(0) !== 1) throw new Error('bad version');
  const f32 = (dv.getUint8(1) & FLAG_F32) !== 0;
  const deg = dv.getUint8(2);
  const nseg = dv.getUint16(4, true);
  const margin = dv.getUint16(6, true);
  const dayStart = dv.getUint32(8, true) * 1000;
  const N = deg + 1;
  const coef = new Float64Array(nseg * 3 * N);
  let p = HEADER_BYTES;
  for (let r = 0; r < nseg * 3; r++) {
    const o = r * N;
    for (let j = 0; j < N; j++) {
      if (!f32 || j === 0) { coef[o + j] = dv.getFloat64(p, true); p += 8; }
      else { coef[o + j] = dv.getFloat32(p, true); p += 4; }
    }
  }
  const t0 = dayStart - margin * 1000;
  return { deg, nseg, t0, len: ((DAY_S + 2 * margin) * 1000) / nseg, coef };
}

/** Position (km TEME) at tMs into out[o..o+3). Returns false if tMs is outside coverage. */
export function evalDecoded(d: Decoded, tMs: number, out: Float64Array, o = 0): boolean {
  const rel = tMs - d.t0;
  const span = d.len * d.nseg;
  if (rel < -1e-6 || rel > span + 1e-6) return false;
  let s = Math.floor(rel / d.len);
  if (s >= d.nseg) s = d.nseg - 1;
  if (s < 0) s = 0;
  const x = (2 * (rel - s * d.len)) / d.len - 1;
  const N = d.deg + 1;
  const b = s * 3 * N;
  out[o] = clenshaw(d.coef, b, N, x);
  out[o + 1] = clenshaw(d.coef, b + N, N, x);
  out[o + 2] = clenshaw(d.coef, b + 2 * N, N, x);
  return true;
}
/** Velocity (km/s TEME) via the Chebyshev derivative. */
export function evalDecodedVelocity(d: Decoded, tMs: number, out: Float64Array, o = 0): boolean {
  const rel = tMs - d.t0;
  const span = d.len * d.nseg;
  if (rel < -1e-6 || rel > span + 1e-6) return false;
  let s = Math.floor(rel / d.len);
  if (s >= d.nseg) s = d.nseg - 1;
  if (s < 0) s = 0;
  const x = (2 * (rel - s * d.len)) / d.len - 1;
  const N = d.deg + 1;
  const b = s * 3 * N;
  const k = 2000 / d.len; // dx/dt in 1/ms is 2/len; times 1000 ms/s
  out[o] = chebDeriv(d.coef, b, N, x) * k;
  out[o + 1] = chebDeriv(d.coef, b + N, N, x) * k;
  out[o + 2] = chebDeriv(d.coef, b + 2 * N, N, x) * k;
  return true;
}

export const evalDayLine = (buf: Uint8Array, tMs: number): [number, number, number] | null => {
  const o = new Float64Array(3);
  return evalDecoded(decodeDayLine(buf), tMs, o) ? [o[0]!, o[1]!, o[2]!] : null;
};
export const evalVelocity = (buf: Uint8Array, tMs: number): [number, number, number] | null => {
  const o = new Float64Array(3);
  return evalDecodedVelocity(decodeDayLine(buf), tMs, o) ? [o[0]!, o[1]!, o[2]!] : null;
};

/**
 * Many objects, pre-decoded once into one big Float64Array. evalAll(t) fills positions for every object.
 */
export class BatchEphem {
  readonly count: number;
  readonly coef: Float64Array;
  readonly offset: Uint32Array; // start of each object's coefficients
  readonly deg: Uint8Array;
  readonly nseg: Uint16Array;
  readonly t0: Float64Array;
  readonly len: Float64Array;
  constructor(bufs: Uint8Array[]) {
    this.count = bufs.length;
    const ds = bufs.map(decodeDayLine);
    let total = 0;
    for (const d of ds) total += d.coef.length;
    this.coef = new Float64Array(total);
    this.offset = new Uint32Array(this.count + 1);
    this.deg = new Uint8Array(this.count);
    this.nseg = new Uint16Array(this.count);
    this.t0 = new Float64Array(this.count);
    this.len = new Float64Array(this.count);
    let o = 0;
    ds.forEach((d, i) => {
      this.offset[i] = o;
      this.coef.set(d.coef, o);
      o += d.coef.length;
      this.deg[i] = d.deg; this.nseg[i] = d.nseg; this.t0[i] = d.t0; this.len[i] = d.len;
    });
    this.offset[this.count] = o;
  }
  /** Position of object i at tMs into out[o..o+3); false if outside coverage. */
  evalOne(i: number, tMs: number, out: Float64Array, o: number): boolean {
    const len = this.len[i]!, nseg = this.nseg[i]!;
    const rel = tMs - this.t0[i]!;
    if (rel < -1e-6 || rel > len * nseg + 1e-6) return false;
    let s = Math.floor(rel / len);
    if (s >= nseg) s = nseg - 1;
    if (s < 0) s = 0;
    const x = (2 * (rel - s * len)) / len - 1;
    const N = this.deg[i]! + 1;
    const b = this.offset[i]! + s * 3 * N;
    out[o] = clenshaw(this.coef, b, N, x);
    out[o + 1] = clenshaw(this.coef, b + N, N, x);
    out[o + 2] = clenshaw(this.coef, b + 2 * N, N, x);
    return true;
  }
  /** All objects at one instant into out (3*count). Objects outside coverage get NaN. */
  evalAll(tMs: number, out: Float64Array): void {
    for (let i = 0; i < this.count; i++) if (!this.evalOne(i, tMs, out, i * 3)) { out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = NaN; }
  }
}
