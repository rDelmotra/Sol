// ============================================================
// SPIKE — not production. U5: shared definitions for the uncertainty model.
// Object classes, gap bins, robust statistics, growth-law fit.
// ============================================================

import { fileURLToPath } from 'node:url';
export const UDIR = fileURLToPath(new URL('../../data/uncertainty/', import.meta.url));
export const MIN_GAP_D = 0.25;
export const MAX_GAP_D = 14;
/** Gap bins (days): [lo, hi). */
export const GAP_BINS: Array<[number, number]> = [[0.25, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 5], [5, 7], [7, 10], [10, 14.0001]];
export const gapBinOf = (g: number): number => GAP_BINS.findIndex(([lo, hi]) => g >= lo && g < hi);

/** LEO perigee bands (km above surface). */
export const LEO_BANDS: Array<[number, number, string]> = [[-1e9, 400, 'p<400'], [400, 600, 'p400-600'], [600, 800, 'p600-800'], [800, 1e9, 'p>=800']];
export const leoBand = (perigeeKm: number): string => LEO_BANDS.find(([lo, hi]) => perigeeKm >= lo && perigeeKm < hi)![2];

export type ObjType = 'unknown' | 'rocket_body' | 'debris';
export const normType = (t: unknown): ObjType => (t === 'rocket_body' || t === 'debris' ? t : 'unknown');
export const normRegime = (r: unknown): string => (r === 'LEO' || r === 'MEO' || r === 'GEO' || r === 'HEO' ? (r as string) : 'OTHER');

/** LEO drag bands by |BSTAR| (1 / earth radii): the strongest single predictor of along-track error. */
export const BSTAR_EDGES = [1e-4, 5e-4, 1.5e-3];
export const bstarBand = (bstar: number): string => `b${BSTAR_EDGES.filter((e) => Math.abs(bstar) >= e).length}`;

/** Class key: regime/type, and for LEO also the perigee band and the drag band (when bstar is known). */
export function classKey(regime: string, type: string, perigeeKm: number, bstar?: number): string {
  const r = normRegime(regime);
  if (r !== 'LEO') return `${r}/${type}`;
  const base = `LEO/${type}/${leoBand(perigeeKm)}`;
  return bstar === undefined || !Number.isFinite(bstar) ? base : `${base}/${bstarBand(bstar)}`;
}
/** Coarser fallbacks, most specific first (excluding the key itself). */
export function fallbackKeys(key: string): string[] {
  const p = key.split('/');
  const out: string[] = [];
  if (p.length === 4) out.push(`${p[0]}/${p[1]}/${p[2]}`);
  if (p.length >= 3) out.push(`${p[0]}/${p[1]}`, `${p[0]}/${p[2]}`);
  out.push(p[0]!, 'ALL');
  return out;
}

// ---------------- pair-file layout ----------------
export const FLAG_JUMP = 1;       // manoeuvre candidate between the two epochs (T2 rule)
export const FLAG_LOWRADIUS = 2;  // either position below 6,400 km radius (decayed / garbage)
export const FLAG_BADOBJ = 4;     // NORAD 54922
export const FLAG_IDENTICAL = 8;  // belongs to a group of identical element sets
export const FLAG_HUGE = 16;      // radius change > 100,000 km versus the new set (garbage propagation)
export const BAD_NORAD = 54922;
/** Float32 columns per pair. */
export const COLS = ['obj', 'gap', 'newDay', 'dR', 'dI', 'dC', 'dvR', 'dvI', 'dvC', 'flags', 'rNew'] as const;
export const NCOL = COLS.length;
export const T2_JUMP = { dposKm: 16.3, daKm: 1, residKm: 1 };

// ---------------- robust statistics ----------------
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const x = (n - 1) * q, i = Math.floor(x), f = x - i;
  return i + 1 < n ? sorted[i]! * (1 - f) + sorted[i + 1]! * f : sorted[i]!;
}
export const sortedCopy = (a: ArrayLike<number>): Float64Array => Float64Array.from(a as ArrayLike<number>).sort();
/** Robust sigma of values around zero-or-median: 1.4826 x median absolute deviation about the median. */
export function madSigma(a: ArrayLike<number>): { med: number; sigma: number } {
  const s = sortedCopy(a);
  const med = quantile(s, 0.5);
  const dev = Float64Array.from(s, (v) => Math.abs(v - med)).sort();
  return { med, sigma: 1.4826 * quantile(dev, 0.5) };
}

// ---------------- growth law fit ----------------
/** Solve small normal equations by Gaussian elimination. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const d = M[c]![c]!;
    if (Math.abs(d) < 1e-300) return new Array(n).fill(0);
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / d;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}
/** Weighted least squares of y on [1, t, t^2] (deg 0..2). */
function polyFit(t: number[], y: number[], w: number[], deg: number): number[] {
  const m = deg + 1;
  const A = Array.from({ length: m }, () => new Array(m).fill(0)) as number[][];
  const b = new Array(m).fill(0) as number[];
  for (let i = 0; i < t.length; i++) {
    const row = Array.from({ length: m }, (_, k) => t[i]! ** k);
    for (let r = 0; r < m; r++) {
      b[r]! += w[i]! * row[r]! * y[i]!;
      for (let c = 0; c < m; c++) A[r]![c]! += w[i]! * row[r]! * row[c]!;
    }
  }
  return solve(A, b);
}
/**
 * sigma(t) = a + b t + c t^2 with a, b, c >= 0 (an error never shrinks with age), fitted to (t, sigma) points by
 * least squares on RELATIVE error (weights w / y^2, so short gaps count as much as long ones). All 7 non-empty
 * term subsets are tried; the best subset whose unconstrained solution is non-negative wins (exact NNLS for 3 terms).
 */
export function fitGrowth(t: number[], y: number[], w: number[]): { a: number; b: number; c: number; form: string } {
  const wr = w.map((wi, i) => wi / (y[i]! * y[i]!));
  let best: { a: number; b: number; c: number; form: string; sse: number } | null = null;
  const subsets: number[][] = [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]];
  for (const sub of subsets) {
    const m = sub.length;
    const A = Array.from({ length: m }, () => new Array(m).fill(0)) as number[][];
    const b = new Array(m).fill(0) as number[];
    for (let i = 0; i < t.length; i++) {
      const row = sub.map((k) => t[i]! ** k);
      for (let r = 0; r < m; r++) {
        b[r]! += wr[i]! * row[r]! * y[i]!;
        for (let c = 0; c < m; c++) A[r]![c]! += wr[i]! * row[r]! * row[c]!;
      }
    }
    const co = solve(A, b);
    if (co.some((v) => !(v >= 0))) continue;
    const full = [0, 0, 0];
    sub.forEach((k, j) => (full[k] = co[j]!));
    let sse = 0;
    for (let i = 0; i < t.length; i++) { const f = full[0]! + full[1]! * t[i]! + full[2]! * t[i]! * t[i]!; sse += wr[i]! * (f - y[i]!) ** 2; }
    if (!best || sse < best.sse - 1e-12) best = { a: full[0]!, b: full[1]!, c: full[2]!, form: sub.map((k) => ['a', 'bt', 'ct2'][k]).join('+'), sse };
  }
  return best ?? { a: Math.max(...y), b: 0, c: 0, form: 'max' };
}
