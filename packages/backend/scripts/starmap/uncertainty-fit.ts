// ============================================================
// SPIKE — not production. U5 step 2: fit the uncertainty model from data/uncertainty/pairs.bin and calibrate it
// on held-out days. Writes data/uncertainty/model.json and data/uncertainty/fit-report.json.
//
// Method: robust sigma per axis (1.4826 x median |offset|, centred on zero) per class x gap bin; growth law
// a + b t + c t^2 per class and axis by weighted least squares over the bins; calibration of the Mahalanobis
// distance (diagonal RIC covariance) of held-out pairs against chi-square(3); then tail factors and per-object
// scales, each measured on the training days only and judged on the held-out days.
// Usage: npx tsx packages/backend/scripts/starmap/uncertainty-fit.ts [--holdout-days 5] [--explore]
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { chi3Cdf } from '@orbitwatch/orbital-core';
import { parseArgs } from './catalog.js';
import {
  UDIR, COLS, NCOL, GAP_BINS, gapBinOf, quantile, sortedCopy, fitGrowth, fallbackKeys, normRegime,
  FLAG_JUMP, FLAG_LOWRADIUS, FLAG_BADOBJ, FLAG_IDENTICAL, FLAG_HUGE,
} from './uncertainty-lib.js';
import { sigmaRIC, type UncertaintyModel, type Law } from './uncertainty-model.js';

const args = parseArgs(process.argv.slice(2));
const HOLD = Number(args.get('holdout-days') ?? 5);
const OUT = args.get('out') ?? (HOLD > 0 ? 'model-holdout.json' : 'model.json');
const VAL_DAYS = 5; // last training days used to fit tail factors (scales come from the days before)
const meta = JSON.parse(readFileSync(UDIR + 'pairs-meta.json', 'utf8'));
const raw = readFileSync(UDIR + 'pairs.bin');
const P = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const N = P.length / NCOL;
const ci = Object.fromEntries(COLS.map((c, i) => [c, i])) as Record<(typeof COLS)[number], number>;
const objs = meta.objectsTable as Array<{ idx: number; norad: number; regime: string; type: string; cls: string; identical: boolean }>;
const nDays = meta.days.length;
const testFrom = nDays - HOLD;
const g = (row: number, c: (typeof COLS)[number]) => P[row * NCOL + ci[c]]!;
const AX = ['R', 'I', 'C'] as const;
const CHI3_MEDIAN = 2.365973884375338;
const EXPECT = [chi3Cdf(1), chi3Cdf(4), chi3Cdf(9)];

// ---------- fences ----------
const fenceCount = { total: N, bad54922: 0, identical: 0, lowRadius: 0, huge: 0, jump: 0, anyFence: 0 };
const kept: number[] = [];
for (let i = 0; i < N; i++) {
  const f = g(i, 'flags');
  if (f & FLAG_BADOBJ) fenceCount.bad54922++;
  if (f & FLAG_IDENTICAL) fenceCount.identical++;
  if (f & FLAG_LOWRADIUS) fenceCount.lowRadius++;
  if (f & FLAG_HUGE) fenceCount.huge++;
  if (f & FLAG_JUMP) fenceCount.jump++;
  if (f) fenceCount.anyFence++; else kept.push(i);
}
const train = kept.filter((i) => g(i, 'newDay') < testFrom);
const test = kept.filter((i) => g(i, 'newDay') >= testFrom);
console.log('pairs', N, 'fences', fenceCount, 'kept', kept.length, 'train', train.length, 'test', test.length);

const regimeOf = (row: number) => normRegime(objs[g(row, 'obj')]!.regime);
const clsOf = (row: number) => objs[g(row, 'obj')]!.cls;

// ---------- class tables ----------
function keysFor(row: number): string[] {
  const c = clsOf(row);
  return [c, ...fallbackKeys(c)];
}
// rows per key (a pair counts toward its class and every coarser level)
function groupRows(rows: number[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const r of rows) for (const k of keysFor(r)) { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(r); }
  return m;
}
interface BinStat { lo: number; hi: number; n: number; medGap: number; sigma: number[]; p50: number[]; p90: number[]; p99: number[]; vsigma: number[]; pos3d: number[] }
function binStats(rows: number[]): BinStat[] {
  const byBin: number[][] = GAP_BINS.map(() => []);
  for (const r of rows) { const b = gapBinOf(g(r, 'gap')); if (b >= 0) byBin[b]!.push(r); }
  return byBin.map((rs, b) => {
    const st: BinStat = { lo: GAP_BINS[b]![0], hi: GAP_BINS[b]![1], n: rs.length, medGap: NaN, sigma: [], p50: [], p90: [], p99: [], vsigma: [], pos3d: [] };
    if (!rs.length) return st;
    st.medGap = quantile(sortedCopy(rs.map((r) => g(r, 'gap'))), 0.5);
    for (const [ax, vax] of [['dR', 'dvR'], ['dI', 'dvI'], ['dC', 'dvC']] as const) {
      const a = sortedCopy(rs.map((r) => Math.abs(g(r, ax))));
      st.p50.push(quantile(a, 0.5)); st.p90.push(quantile(a, 0.9)); st.p99.push(quantile(a, 0.99));
      st.sigma.push(1.4826 * quantile(a, 0.5));
      st.vsigma.push(1.4826 * quantile(sortedCopy(rs.map((r) => Math.abs(g(r, vax)))), 0.5));
    }
    const n3 = sortedCopy(rs.map((r) => Math.hypot(g(r, 'dR'), g(r, 'dI'), g(r, 'dC'))));
    st.pos3d = [quantile(n3, 0.5), quantile(n3, 0.9), quantile(n3, 0.99)];
    return st;
  });
}
const MIN_CLASS_PAIRS = 3000, MIN_BIN = 100;
const groups = groupRows(train);
const tables: Record<string, { n: number; bins: BinStat[]; growth: Record<string, Law> }> = {};
for (const [k, rs] of groups) {
  if (rs.length < MIN_CLASS_PAIRS && k !== 'ALL') continue;
  const bins = binStats(rs);
  const use = bins.filter((b) => b.n >= MIN_BIN);
  if (use.length < 4 && k !== 'ALL') continue;
  const growth: Record<string, Law> = {};
  AX.forEach((ax, a) => { growth[ax] = fitGrowth(use.map((b) => b.medGap), use.map((b) => b.sigma[a]!), use.map((b) => b.n)); });
  tables[k] = { n: rs.length, bins, growth };
}
const model: UncertaintyModel = {
  version: 1,
  classes: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, { n: v.n, growth: v.growth as any }])),
  tail: {}, objectScale: {},
};

// ---------- calibration ----------
interface Cov { n: number; in1: number; in2: number; in3: number; medD2Ratio: number; d99: number }
function mahal(row: number, m: UncertaintyModel, withObj: boolean): number {
  const o = objs[g(row, 'obj')]!;
  const s = sigmaRIC(withObj ? { noradId: o.norad, regime: o.regime, objectType: o.type, perigee: (o as any).perigee, bstar: (o as any).bstar } : o.cls, g(row, 'gap'), m);
  const a = g(row, 'dR') / s[0], b = g(row, 'dI') / s[1], c = g(row, 'dC') / s[2];
  return Math.sqrt(a * a + b * b + c * c);
}
function coverage(rows: number[], m: UncertaintyModel, withObj: boolean): Cov {
  const d = rows.map((r) => mahal(r, m, withObj));
  const n = d.length;
  let a = 0, b = 0, c = 0;
  for (const x of d) { if (x <= 1) a++; if (x <= 2) b++; if (x <= 3) c++; }
  const s = sortedCopy(d.map((x) => x * x));
  return { n, in1: a / n, in2: b / n, in3: c / n, medD2Ratio: quantile(s, 0.5) / CHI3_MEDIAN, d99: Math.sqrt(quantile(s, 0.99)) };
}
const REG = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];
function calTable(rows: number[], m: UncertaintyModel, withObj: boolean) {
  const out: Record<string, Cov> = { ALL: coverage(rows, m, withObj) };
  for (const r of REG) { const rs = rows.filter((x) => regimeOf(x) === r); if (rs.length) out[r] = coverage(rs, m, withObj); }
  return out;
}
const fmt = (c: Cov) => `n=${c.n} 1s=${(100 * c.in1).toFixed(1)} 2s=${(100 * c.in2).toFixed(1)} 3s=${(100 * c.in3).toFixed(1)} medRatio=${c.medD2Ratio.toFixed(2)} d99=${c.d99.toFixed(2)}`;
const show = (title: string, t: Record<string, Cov>) => { console.log(title, '(expect 19.9 / 73.9 / 97.1)'); for (const [k, v] of Object.entries(t)) console.log('  ', k.padEnd(6), fmt(v)); };


const pctl = (a: number[], q: number) => quantile(sortedCopy(a), q);
const kLevels = [1, 2, 3];
/** Scale k so that the share of d <= j*k is closest (minimax over j = 1, 2, 3) to the chi-square(3) share. */
function fitTail(d: number[]): { k: number; k1: number; k2: number; k3: number } {
  const s = sortedCopy(d);
  const cov = (k: number, j: number) => { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m]! <= j * k) lo = m + 1; else hi = m; } return lo / s.length; };
  const exp = [EXPECT[0]!, EXPECT[1]!, EXPECT[2]!];
  const fit1 = (j: number) => { let a = 0.05, b = 200; for (let it = 0; it < 80; it++) { const m = Math.sqrt(a * b); if (cov(m, j) < exp[j - 1]!) a = m; else b = m; } return Math.sqrt(a * b); };
  let best = 1, be = Infinity;
  for (let x = Math.log(0.1); x <= Math.log(100); x += 0.005) { const k = Math.exp(x); const e = Math.max(...kLevels.map((j) => Math.abs(cov(k, j) - exp[j - 1]!))); if (e < be) { be = e; best = k; } }
  return { k: best, k1: fit1(1), k2: fit1(2), k3: fit1(3) };
}

// ---------- per-object scale (per axis, shrunk) ----------
const MIN_OBJ_PAIRS = 8;
function objectScalesAxis(rows: number[], m: UncertaintyModel, shrinkK: number): Record<string, [number, number, number]> {
  const by = new Map<number, number[][]>();
  for (const r of rows) {
    const o = g(r, 'obj');
    const sg = sigmaRIC(objs[o]!.cls, g(r, 'gap'), m);
    let a = by.get(o); if (!a) by.set(o, (a = [[], [], []]));
    a[0]!.push(Math.abs(g(r, 'dR') / sg[0])); a[1]!.push(Math.abs(g(r, 'dI') / sg[1])); a[2]!.push(Math.abs(g(r, 'dC') / sg[2]));
  }
  const out: Record<string, [number, number, number]> = {};
  for (const [o, z] of by) {
    const n = z[0]!.length;
    if (n < MIN_OBJ_PAIRS) continue;
    const w = n / (n + shrinkK);
    out[String(objs[o]!.norad)] = z.map((za) => Math.exp(w * Math.log(Math.min(20, Math.max(0.05, quantile(sortedCopy(za), 0.5) / 0.6744897501960817))))) as [number, number, number];
  }
  return out;
}
const SHRINK = 0;
const trainA = train.filter((r) => g(r, 'newDay') < testFrom - VAL_DAYS);
const trainB = train.filter((r) => g(r, 'newDay') >= testFrom - VAL_DAYS);
console.log('train A (scales)', trainA.length, 'train B (tail factors)', trainB.length);

// 1) tail factors with scales from A, measured on B (gap-dependent), plus a cold-start factor from all training pairs
const mA: UncertaintyModel = { ...model, objectScale: objectScalesAxis(trainA, model, SHRINK) };
const mAll: UncertaintyModel = { ...model, objectScale: objectScalesAxis(train, model, SHRINK) };
const bWarm = (r: number) => mA.objectScale[String(objs[g(r, 'obj')]!.norad)] !== undefined;
const centres = tables.ALL!.bins.map((b) => b.medGap);
const NaNTail = { k: NaN, k1: NaN, k2: NaN, k3: NaN };
const regimeTail: Record<string, any> = {};
const tailWarm: Record<string, number[]> = {}, tailColdM: Record<string, number> = {};
const dB = new Map<number, number>();
for (const r of trainB) dB.set(r, mahal(r, mA, true));
const coldTrain = train.filter((r) => mAll.objectScale[String(objs[g(r, 'obj')]!.norad)] === undefined);
const dCold = new Map<number, number>();
for (const r of coldTrain) dCold.set(r, mahal(r, mAll, false));
for (const reg of ['ALL', ...REG]) {
  const rs = trainB.filter((r) => (reg === 'ALL' || regimeOf(r) === reg) && bWarm(r));
  const overall = rs.length > 200 ? fitTail(rs.map((r) => dB.get(r)!)) : NaNTail;
  const perGap: Array<ReturnType<typeof fitTail> & { n: number }> = GAP_BINS.map((_, b) => {
    const rb = rs.filter((r) => gapBinOf(g(r, 'gap')) === b);
    return { ...(rb.length >= 400 ? fitTail(rb.map((r) => dB.get(r)!)) : NaNTail), n: rb.length };
  });
  const cr = coldTrain.filter((r) => reg === 'ALL' || regimeOf(r) === reg);
  const cold = cr.length > 200 ? fitTail(cr.map((r) => dCold.get(r)!)) : NaNTail;
  regimeTail[reg] = { warmOverall: overall, warmByGap: perGap, cold, nWarm: rs.length, nCold: cr.length };
}
for (const reg of ['ALL', ...REG]) {
  const t = regimeTail[reg]!;
  const fallbackAll = regimeTail.ALL!;
  // regime x gap factor: own value if enough data, else the regime's overall value scaled by ALL's gap shape
  tailWarm[reg] = GAP_BINS.map((_, b) => {
    const own = t.warmByGap[b].k;
    if (Number.isFinite(own)) return own;
    const shape = fallbackAll.warmByGap[b].k / fallbackAll.warmOverall.k;
    return (Number.isFinite(t.warmOverall.k) ? t.warmOverall.k : fallbackAll.warmOverall.k) * (Number.isFinite(shape) ? shape : 1);
  });
  tailColdM[reg] = Number.isFinite(t.cold.k) ? t.cold.k : regimeTail.ALL!.cold.k;
}
console.log('tail factors per gap bin (warm, minimax k) and cold k');
for (const reg of ['ALL', ...REG]) console.log('  ', reg.padEnd(6), tailWarm[reg]!.map((x) => x.toFixed(2)).join(' '), ' cold', tailColdM[reg]!.toFixed(2), 'nCold', regimeTail[reg].nCold, 'k1/k2/k3 cold', ['k1', 'k2', 'k3'].map((q) => regimeTail[reg].cold[q].toFixed(2)).join('/'));

// 2) final model: scales from all training days, tail factors from the validation fit
const conservative: Record<string, number> = {};
for (const reg of ['ALL', ...REG]) { const w = regimeTail[reg].warmOverall; conservative[reg] = Number.isFinite(w.k3) ? w.k3 / w.k : regimeTail.ALL!.warmOverall.k3 / regimeTail.ALL!.warmOverall.k; }
console.log('conservative multipliers', conservative);
const finalModel: UncertaintyModel = { ...model, objectScale: mAll.objectScale, tail: tailWarm, tailCold: tailColdM, tailCentresDays: centres, conservative } as UncertaintyModel;

// ---------- calibration tables (held-out) ----------
const hasScale = (r: number) => finalModel.objectScale[String(objs[g(r, 'obj')]!.norad)] !== undefined;
const baseM: UncertaintyModel = { ...model, tail: {}, objectScale: {} };

const staged: Record<string, Record<string, Cov>> = {};
let rep: any = { fenceCount, nPairs: N, nKept: kept.length, nTrain: train.length, nTest: test.length, trainA: trainA.length, trainB: trainB.length, holdout: { days: meta.days.slice(testFrom), count: HOLD }, expected: EXPECT, regimeTail, shrink: SHRINK };
if (HOLD > 0) {
  staged.before = calTable(test, baseM, false);
  const m1: UncertaintyModel = { ...model, tail: {}, tailCold: {}, objectScale: finalModel.objectScale } as UncertaintyModel;
  staged.objectScaleOnly = calTable(test.filter(hasScale), m1, true);
  staged.coldBefore = calTable(test.filter((r) => !hasScale(r)), baseM, false);
  // shipped model: scaled objects use scales + tail, the rest use class level + tailCold
  const shipped = (rows: number[]) => {
    const out: Record<string, Cov> = {};
    for (const reg of ['ALL', ...REG]) {
      const rs = rows.filter((r) => reg === 'ALL' || regimeOf(r) === reg);
      if (!rs.length) continue;
      const d = rs.map((r) => mahal(r, finalModel, true));
      out[reg] = covFrom(d);
    }
    return out;
  };
  staged.after = shipped(test);
  {
    const out: Record<string, Cov> = {};
    for (const reg of ['ALL', ...REG]) {
      const rs = test.filter((r) => hasScale(r) && (reg === 'ALL' || regimeOf(r) === reg));
      if (!rs.length) continue;
      out[reg] = covFrom(rs.map((r) => { const o = objs[g(r, 'obj')]!; const sg = sigmaRIC({ noradId: o.norad, regime: o.regime, objectType: o.type, perigee: (o as any).perigee, bstar: (o as any).bstar }, g(r, 'gap'), finalModel, true); return Math.hypot(g(r, 'dR') / sg[0], g(r, 'dI') / sg[1], g(r, 'dC') / sg[2]); }));
    }
    staged.afterConservativeWarm = out;
  }
  staged.afterWarm = shipped(test.filter(hasScale));
  staged.afterCold = shipped(test.filter((r) => !hasScale(r)));
  for (const [k, v] of Object.entries(staged)) show(k, v);
  // by gap bin, shipped
  const byGap: Record<string, Cov> = {};
  for (let b = 0; b < GAP_BINS.length; b++) { const rs = test.filter((r) => gapBinOf(g(r, 'gap')) === b); if (rs.length) { byGap[`${GAP_BINS[b]![0]}-${Math.floor(GAP_BINS[b]![1])}`] = covFrom(rs.map((r) => mahal(r, finalModel, true))); } }
  show('after, by gap bin (days)', byGap);
  staged.afterByGap = byGap;
  const byGapBefore: Record<string, Cov> = {};
  for (let b = 0; b < GAP_BINS.length; b++) { const rs = test.filter((r) => gapBinOf(g(r, 'gap')) === b); if (rs.length) byGapBefore[`${GAP_BINS[b]![0]}-${Math.floor(GAP_BINS[b]![1])}`] = covFrom(rs.map((r) => mahal(r, baseM, false))); }
  staged.beforeByGap = byGapBefore;
  // by LEO class
  const byClass: Record<string, Cov> = {};
  for (const c of new Set(test.map(clsOf))) { const rs = test.filter((r) => clsOf(r) === c); if (rs.length >= 2000) byClass[c] = covFrom(rs.map((r) => mahal(r, finalModel, true))); }
  staged.afterByClass = byClass;
  rep.stages = staged;
}
function covFrom(d: number[]): Cov {
  const n = d.length;
  let a = 0, b = 0, c = 0;
  for (const x of d) { if (x <= 1) a++; if (x <= 2) b++; if (x <= 3) c++; }
  const s = sortedCopy(d.map((x) => x * x));
  return { n, in1: a / n, in2: b / n, in3: c / n, medD2Ratio: quantile(s, 0.5) / CHI3_MEDIAN, d99: Math.sqrt(quantile(s, 0.99)) };
}

// ---------- scale distribution ----------
const scaleStats: Record<string, any> = {};
for (const reg of ['ALL', ...REG]) {
  const rows = Object.entries(finalModel.objectScale).filter(([nid]) => reg === 'ALL' || objs.find((o) => o.norad === Number(nid))?.regime === reg);
  if (!rows.length) continue;
  scaleStats[reg] = { n: rows.length };
  AX.forEach((ax, a) => { const v = rows.map(([, s]) => (s as number[])[a]!); scaleStats[reg][ax] = [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => pctl(v, q)); });
}
rep.scaleStats = scaleStats;
rep.objectsWithScale = Object.keys(finalModel.objectScale).length;
rep.objectsEligible = objs.filter((o) => !o.identical && o.norad !== 54922).length;

// ---------- model.json ----------
const outModel = {
  ...finalModel,
  built: { pairs: kept.length, trainPairs: train.length, days: meta.days, holdoutDays: HOLD, fences: fenceCount, note: 'sigma = 1-sigma position error (km) in radial/in-track/cross-track at ageDays after the element-set epoch; growth laws fitted to robust per-bin sigma of (older set propagated to newer epoch) minus (newer set); includes the newer set own epoch error (conservative at small age)' },
  gapBinsDays: GAP_BINS,
  tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, { n: v.n, bins: v.bins }])),
};
writeFileSync(UDIR + OUT, JSON.stringify(outModel));
rep.tables = tables;
writeFileSync(UDIR + 'fit-report' + (HOLD > 0 ? '' : '-all') + '.json', JSON.stringify(rep));
console.log('wrote', OUT, 'objects with scale', rep.objectsWithScale, 'of', rep.objectsEligible);
