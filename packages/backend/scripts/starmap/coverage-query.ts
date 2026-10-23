// ============================================================
// SPIKE — not production. Layer 2 queries over the STAR-MAP coverage files.
//
//   npx tsx packages/backend/scripts/starmap/coverage-query.ts --stage truth --truth-days 2026-10-12,2026-10-18
//   npx tsx packages/backend/scripts/starmap/coverage-query.ts --stage query [--ndays 29] [--timing-days 3]
//   npx tsx packages/backend/scripts/starmap/coverage-query.ts --stage report
//
// Q-L1  who passed over India (any height) in the last N days, and when
//         India (polygon) is rotated INTO the star map for each time slice (coverage-cover.ts) -> star cells
//         -> merge the stored lists -> candidate (object, period) -> exact SGP4 refine on candidate windows
// Q-L2  who passed through order-3 star-map box B in the last N days, and when (cover = the box itself,
//         its parent at order 2, its 8 children at order 4)
// For every question the 9 variants (granularity day/hour/10-min x order 2/3/4) are merged separately.
// Refine runs ONCE per day on the union of all variants' windows (so every variant's answer can be read off
// exactly: a pass is found by a variant iff all periods the pass touches are candidates), and each
// variant's own-window refine is re-run on a few sample days to measure its refine time and to check that it
// returns the same passes. TRUTH = brute force SGP4 at 10 s for ALL objects on the truth days.
// State is cached as JSON/binary under data/coverage/q/ (gitignored).
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { cellCentre, decodeKey, pix2angNest, SHELL_DELTA0, WGS84_A_KM, DEG } from '@orbitwatch/orbital-core';
import { loadCatalog, parseArgs, type CatObj } from './catalog.js';
import { Pool, dailyDays, COVERAGE_DIR, DAY_MS, GRANS, STAR_ORDERS, type DayInfo } from './coverage-lib.js';
import { forEachId } from './coverage-codec.js';
import { readDay, mergeCover, windowsOf, expandTo144, unindexedNorads } from './coverage-qlib.js';
import { polygonPixelsByTenMin, groupPixels, cellsOf } from './coverage-cover.js';
import type { RefineTask, RefineOut, TruthTask, TruthOut, BoxSpec } from './coverage-worker.js';

const a = parseArgs(process.argv.slice(2));
const stage = a.get('stage') ?? 'query';
const WORKERS = Number(a.get('workers') ?? 4);
const Q_DIR = COVERAGE_DIR + 'q/';
mkdirSync(Q_DIR, { recursive: true });
const allDays = dailyDays();
const days: DayInfo[] = allDays.slice(-Number(a.get('ndays') ?? 29));
const secs = (t0: number) => (performance.now() - t0) / 1000;
const log = (...x: unknown[]) => console.log(...x);
const REGIMES = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];
const QS = ['india', 'box'] as const;
type Q = (typeof QS)[number];

// ---------------------------------------------------------------- box B
function pickBox(): BoxSpec & { count: number } {
  const fixed = a.get('box-key');
  const last = readDay(allDays[allDays.length - 1]!.day, 'day');
  const cfg = last.configs.find((c) => c.order === 3)!;
  let best = fixed ? Number(fixed) : -1, bestN = -1;
  for (let i = 0; i < cfg.cells.length; i++) {
    const key = cfg.cells[i]!;
    if (fixed && key !== best) continue;
    const c = cellCentre(3, key);
    if (Math.hypot(c.x, c.y, c.z) > WGS84_A_KM + 2000) continue; // LEO shells only
    let n = 0; forEachId(last.buf, cfg.offs[i]!, cfg.lens[i]!, cfg.tags[i]!, () => n++);
    if (fixed || n > bestN) { bestN = n; best = key; }
  }
  const { pix, nk } = decodeKey(3, best);
  const rLo = WGS84_A_KM * Math.exp((nk * SHELL_DELTA0) / 8), rHi = WGS84_A_KM * Math.exp(((nk + 1) * SHELL_DELTA0) / 8);
  const cen = pix2angNest(3, pix), cs = Math.sqrt(1 - cen.z * cen.z);
  const cd = [cs * Math.cos(cen.phi), cs * Math.sin(cen.phi), cen.z] as const;
  let hw = 0;
  for (let q = 0; q < 4 ** 4; q++) { // sub-pixels at order 7 -> angular half width
    const s = pix2angNest(7, pix * 4 ** 4 + q), ss = Math.sqrt(1 - s.z * s.z);
    hw = Math.max(hw, Math.acos(Math.min(1, cd[0] * ss * Math.cos(s.phi) + cd[1] * ss * Math.sin(s.phi) + cd[2] * s.z)));
  }
  return { order: 3, key: best, rLo, rHi, cx: cd[0], cy: cd[1], cz: cd[2], hwRad: hw * 1.05, count: bestN };
}

// ---------------------------------------------------------------- truth
const truthFile = (day: string, box: BoxSpec, ext: string) => `${Q_DIR}truth-${day}-${box.key}.${ext}`;
interface Truth { india: Uint16Array; box: Uint16Array; indiaMask: Uint8Array; boxMask: Uint8Array; wallS: number; propCalls: number }
function loadTruth(day: string, box: BoxSpec): Truth | null {
  if (!existsSync(truthFile(day, box, 'json'))) return null;
  const m = JSON.parse(readFileSync(truthFile(day, box, 'json'), 'utf8')) as { wallS: number; propCalls: number };
  const rd = (e: string) => { const b = readFileSync(truthFile(day, box, e)); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
  const u16 = (e: string) => { const b = rd(e); return new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
  return { india: u16('india'), box: u16('box'), indiaMask: rd('imask'), boxMask: rd('bmask'), wallS: m.wallS, propCalls: m.propCalls };
}
async function runTruth(pool: Pool, d: DayInfo, box: BoxSpec): Promise<Truth> {
  const have = loadTruth(d.day, box); if (have) return have;
  const t0 = performance.now();
  const cat = loadCatalog(d.path);
  const CH = 200, tasks: TruthTask[] = [];
  for (let b = 0; b < cat.length; b += CH) {
    const sl = cat.slice(b, b + CH);
    tasks.push({ kind: 'truth', omms: sl.map((o) => o.omm), norad: sl.map((o) => o.noradId), startMs: d.startMs, stepMs: 10_000, boxOrder: 3, boxKey: box.key });
  }
  const res = await pool.map<TruthOut>(tasks);
  const n = cat.length;
  const t: Truth = { india: new Uint16Array(n), box: new Uint16Array(n), indiaMask: new Uint8Array(n * 144), boxMask: new Uint8Array(n * 144), wallS: 0, propCalls: 0 };
  res.forEach((r, ti) => { t.india.set(r.india, ti * CH); t.box.set(r.box, ti * CH); t.indiaMask.set(r.indiaMask, ti * CH * 144); t.boxMask.set(r.boxMask, ti * CH * 144); t.propCalls += r.propCalls; });
  t.wallS = secs(t0);
  const w = (e: string, arr: Uint8Array | Uint16Array) => writeFileSync(truthFile(d.day, box, e), new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
  w('india', t.india); w('box', t.box); w('imask', t.indiaMask); w('bmask', t.boxMask);
  writeFileSync(truthFile(d.day, box, 'json'), JSON.stringify({ wallS: t.wallS, propCalls: t.propCalls, n }));
  return t;
}

// ---------------------------------------------------------------- merge
// ---------------------------------------------------------------- refine
interface Refined { intervals: Map<number, Float64Array>; wallS: number; items: number; windowS: number; calls: number }
async function refineWindows(pool: Pool, q: Q, box: BoxSpec, cat: CatObj[], wins: Map<number, number[]>): Promise<Refined> {
  const idxs = [...wins.keys()], tasks: RefineTask[] = [];
  let windowS = 0;
  for (const w of wins.values()) for (let k = 0; k < w.length; k += 2) windowS += (w[k + 1]! - w[k]!) / 1000;
  for (let b = 0; b < idxs.length; b += 50) {
    tasks.push({ kind: 'refine', mode: q === 'india' ? 'poly' : 'box', box, stepMs: 20_000, nearStepMs: 1000,
      items: idxs.slice(b, b + 50).map((i) => ({ omm: cat[i]!.omm, windows: wins.get(i)! })) });
  }
  const t0 = performance.now();
  const res = await pool.map<RefineOut>(tasks);
  const wallS = secs(t0);
  const intervals = new Map<number, Float64Array>(); let calls = 0;
  res.forEach((r, ti) => { calls += r.propCalls; r.intervals.forEach((iv, k) => { if (iv.length) intervals.set(idxs[ti * 50 + k]!, iv); }); });
  return { intervals, wallS, items: idxs.length, windowS, calls };
}

// ---------------------------------------------------------------- per-day driver
interface CfgRes {
  gran: string; order: number; coverCells: number; openS: number; mergeS: number; lists: number; bytesTouched: number; idsDecoded: number;
  candPairs: number; candObjDays: number; windowS: number;
  posPairs: number; // candidate (obj,period) pairs containing part of a real pass
  missedObjDays: number; missedPasses: number; // vs union refine (pass touches a non-candidate period)
  candByRegime: number[]; posByRegime: number[];
  refineS?: number; refineItems?: number; sameAsUnion?: boolean; mismatches?: number;
  truth?: { truthObjDays: number; candHit: number; refineHit: number; slices: number; sliceHit: number };
}
interface DayRes {
  day: string; n: number; coverS: Record<string, number>;
  q: Record<Q, { cfgs: CfgRes[]; union: { items: number; wallS: number; windowS: number; calls: number; positives: number; passes: number; byRegime: number[] } }>;
  timing: boolean;
}

const dayResFile = (day: string) => `${Q_DIR}day-${day}.json`;
const regIdx = (cat: CatObj[], i: number) => Math.max(0, REGIMES.indexOf(cat[i]!.regime));

async function doDay(pool: Pool, d: DayInfo, di: number, box: BoxSpec, timingDays: Set<number>): Promise<DayRes> {
  const cat = loadCatalog(d.path), n = cat.length;
  const truth = loadTruth(d.day, box);
  const res: DayRes = { day: d.day, n, coverS: {}, q: { india: { cfgs: [], union: null as never }, box: { cfgs: [], union: null as never } }, timing: timingDays.has(di) };
  // shell range actually present in the data (per order), read off the daily file
  const dayFile = readDay(d.day, 'day');
  const shells = new Map<number, [number, number]>();
  for (const o of STAR_ORDERS) {
    const cfg = dayFile.configs.find((c) => c.order === o)!;
    let lo = Infinity, hi = -Infinity;
    for (const c of cfg.cells) { const nk = decodeKey(o, c).nk; if (nk < lo) lo = nk; if (nk > hi) hi = nk; }
    shells.set(o, [lo, hi]);
  }
  const dropN = unindexedNorads(d.day);
  const always = cat.map((o, i) => (dropN.has(o.noradId) ? i : -1)).filter((i) => i >= 0);
  const pixelsByOrder = new Map<number, Int32Array[]>();
  for (const o of STAR_ORDERS) { const t0 = performance.now(); pixelsByOrder.set(o, polygonPixelsByTenMin(o, d.startMs)); res.coverS[`o${o}`] = secs(t0); }
  const boxCells: Record<number, number[]> = { 2: [Math.floor(box.key / 8)], 3: [box.key], 4: Array.from({ length: 8 }, (_, c) => box.key * 8 + c) };

  for (const q of QS) {
    const union = new Uint8Array(n * 144);
    const cfgMasks: Array<{ cfg: CfgRes; cand: Uint8Array; P: number; gi: number }> = [];
    for (const g of GRANS) {
      const t0 = performance.now(); const cov = readDay(d.day, g.name); const openS = secs(t0);
      for (const o of STAR_ORDERS) {
        let coverOf: (p: number) => number[];
        if (q === 'india') {
          const grouped = groupPixels(pixelsByOrder.get(o)!, g), [lo, hi] = shells.get(o)!;
          const memo: number[][] = [];
          coverOf = (p) => (memo[p] ??= cellsOf(o, grouped[p]!, lo, hi));
        } else {
          const c = boxCells[o]!; coverOf = () => c;
        }
        const m = mergeCover(cov, openS, o, g.perDay, coverOf);
        for (const i of always) m.cand.fill(1, i * g.perDay, (i + 1) * g.perDay);
        let candPairs = 0, candObjDays = 0; const candByRegime = new Array<number>(5).fill(0);
        for (let i = 0; i < n; i++) {
          let any = false;
          for (let p = 0; p < g.perDay; p++) if (m.cand[i * g.perDay + p]) { candPairs++; any = true; }
          if (any) { candObjDays++; candByRegime[regIdx(cat, i)]!++; }
        }
        const w = windowsOf(m.cand, n, g.perDay, d.startMs);
        let windowS = 0; for (const v of w.values()) for (let k = 0; k < v.length; k += 2) windowS += (v[k + 1]! - v[k]!) / 1000;
        const cfg: CfgRes = { gran: g.name, order: o, coverCells: m.cells, openS: m.openS, mergeS: m.mergeS, lists: m.lists, bytesTouched: m.bytes, idsDecoded: m.ids,
          candPairs, candObjDays, windowS, posPairs: 0, missedObjDays: 0, missedPasses: 0, candByRegime, posByRegime: new Array<number>(5).fill(0) };
        cfgMasks.push({ cfg, cand: m.cand, P: g.perDay, gi: g.id });
        expandTo144(m.cand, n, g.perDay, union);
        res.q[q].cfgs.push(cfg);
      }
    }
    // refine ONCE on the union of every variant's windows
    const uw = windowsOf(union, n, 144, d.startMs);
    const ref = await refineWindows(pool, q, box, cat, uw);
    let passes = 0; const byRegime = new Array<number>(5).fill(0);
    for (const [i, iv] of ref.intervals) { passes += iv.length / 2; byRegime[regIdx(cat, i)]!++; }
    res.q[q].union = { items: ref.items, wallS: ref.wallS, windowS: ref.windowS, calls: ref.calls, positives: ref.intervals.size, passes, byRegime };
    // read each variant's answer off the union refine
    for (const { cfg, cand, P } of cfgMasks) {
      const per = DAY_MS / P;
      const posMask = new Uint8Array(n * P);
      const missedObj = new Set<number>(); let missedPasses = 0;
      for (const [i, iv] of ref.intervals) {
        let objHit = false;
        for (let k = 0; k < iv.length; k += 2) {
          const pA = Math.max(0, Math.floor((iv[k]! - 1000 - d.startMs) / per)), pB = Math.min(P - 1, Math.floor((iv[k + 1]! + 1000 - d.startMs) / per));
          let allIn = true;
          for (let p = pA; p <= pB; p++) { posMask[i * P + p] = 1; if (cand[i * P + p]) objHit = true; else allIn = false; }
          if (!allIn) missedPasses++;
        }
        if (!objHit) missedObj.add(i);
        if (objHit) cfg.posByRegime[regIdx(cat, i)]!++;
      }
      let pp = 0; for (let k = 0; k < cand.length; k++) if (cand[k] && posMask[k]) pp++;
      cfg.posPairs = pp; cfg.missedObjDays = missedObj.size; cfg.missedPasses = missedPasses;
      if (truth) {
        const tmask = q === 'india' ? truth.indiaMask : truth.boxMask, tcount = q === 'india' ? truth.india : truth.box;
        const per10 = 144 / P;
        let tObj = 0, candHit = 0, refHit = 0, slices = 0, sliceHit = 0;
        for (let i = 0; i < n; i++) {
          if (!tcount[i]) continue;
          tObj++;
          let anyCand = false;
          for (let s = 0; s < 144; s++) if (tmask[i * 144 + s]) { slices++; if (cand[i * P + Math.floor(s / per10)]) { sliceHit++; anyCand = true; } }
          if (anyCand) candHit++;
          if (ref.intervals.has(i)) refHit++;
        }
        cfg.truth = { truthObjDays: tObj, candHit, refineHit: refHit, slices, sliceHit };
      }
    }
    // timing sample: re-run each variant's own windows and compare with the union answer
    if (res.timing) {
      for (const { cfg, cand, P } of cfgMasks) {
        const w = windowsOf(cand, n, P, d.startMs);
        const r = await refineWindows(pool, q, box, cat, w);
        cfg.refineS = r.wallS; cfg.refineItems = r.items;
        let mism = 0;
        for (const [i, iv] of r.intervals) {
          const u = ref.intervals.get(i);
          if (!u || u.length !== iv.length) { mism++; continue; }
          for (let k = 0; k < iv.length; k++) if (Math.abs(iv[k]! - u[k]!) > 2000) { mism++; break; }
        }
        for (const i of ref.intervals.keys()) if (!r.intervals.has(i) && cfg.missedObjDays === 0) mism++;
        cfg.mismatches = mism; cfg.sameAsUnion = mism === 0;
      }
    }
    // keep the union answer for the shortcut stage and the equivalence checks
    const rows: Array<[number, number[]]> = [...ref.intervals].map(([i, iv]) => [i, [...iv]]);
    writeFileSync(`${Q_DIR}refine-${q}-${d.day}.json`, JSON.stringify(rows));
  }
  writeFileSync(dayResFile(d.day), JSON.stringify(res));
  return res;
}

// ---------------------------------------------------------------- report
function report(box: BoxSpec & { count: number }): void {
  const rs: DayRes[] = [];
  for (const d of days) if (existsSync(dayResFile(d.day))) rs.push(JSON.parse(readFileSync(dayResFile(d.day), 'utf8')) as DayRes);
  log(`report over ${rs.length} days: ${rs[0]?.day}..${rs[rs.length - 1]?.day}; box B order-3 key ${box.key} r ${box.rLo.toFixed(0)}..${box.rHi.toFixed(0)} km (alt ${(box.rLo - WGS84_A_KM).toFixed(0)}..${(box.rHi - WGS84_A_KM).toFixed(0)}), ${box.count} objects on the last day`);
  const f1 = (x: number) => x.toFixed(1), f2 = (x: number) => x.toFixed(2);
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const D5 = 1826;
  for (const q of QS) {
    log(`\n== ${q === 'india' ? 'Q-L1 India' : 'Q-L2 box B'}: ${rs.length} days`);
    const u = rs.map((r) => r.q[q].union);
    log(`TRUE answer (union refine): ${sum(u.map((x) => x.positives))} object-days, ${sum(u.map((x) => x.passes))} passes; union refine ${f1(sum(u.map((x) => x.wallS)))} s for ${sum(u.map((x) => x.items))} candidate object-days; by regime (object-days) ${REGIMES.map((g, k) => `${g} ${sum(u.map((x) => x.byRegime[k]!))}`).join(', ')}`);
    log('gran  order | cover cells/day | open s | merge s | lists | MB touched | cand pairs | cand obj-days | prec(obj-day) | prec(pair) | window h/obj-day | missed obj-days | missed passes | refine s/day(sample) | cand obj-days by regime');
    for (const g of GRANS) for (const o of STAR_ORDERS) {
      const c = rs.map((r) => r.q[q].cfgs.find((x) => x.gran === g.name && x.order === o)!);
      const cand = sum(c.map((x) => x.candObjDays)), pos = sum(c.map((x) => x.posByRegime.reduce((s, y) => s + y, 0)));
      const tim = c.filter((x) => x.refineS !== undefined);
      const rsDay = tim.length ? sum(tim.map((x) => x.refineS!)) / tim.length : NaN;
      const mism = sum(tim.map((x) => x.mismatches ?? 0));
      log(`${g.name.padEnd(5)} ${o} | ${Math.round(sum(c.map((x) => x.coverCells)) / rs.length)} | ${f2(sum(c.map((x) => x.openS)))} | ${f2(sum(c.map((x) => x.mergeS)))} | ${sum(c.map((x) => x.lists))} | ${f1(sum(c.map((x) => x.bytesTouched)) / 1e6)} | ${sum(c.map((x) => x.candPairs))} | ${cand} | ${f1((100 * pos) / cand)}% | ${f1((100 * sum(c.map((x) => x.posPairs))) / sum(c.map((x) => x.candPairs)))}% | ${f2(sum(c.map((x) => x.windowS)) / 3600 / cand)} | ${sum(c.map((x) => x.missedObjDays))} | ${sum(c.map((x) => x.missedPasses))} | ${f2(rsDay)} (${tim.length} d, mismatches ${mism}) | ${REGIMES.map((_, k) => sum(c.map((x) => x.candByRegime[k]!))).join('/')}`);
    }
    const withTruth = rs.filter((r) => r.q[q].cfgs[0]!.truth);
    if (withTruth.length) {
      log(`-- vs TRUTH (${withTruth.length} days: ${withTruth.map((r) => r.day).join(', ')}), 10 s brute force, all objects`);
      for (const g of GRANS) for (const o of STAR_ORDERS) {
        const t = withTruth.map((r) => r.q[q].cfgs.find((x) => x.gran === g.name && x.order === o)!.truth!);
        const T = sum(t.map((x) => x.truthObjDays));
        log(`${g.name.padEnd(5)} ${o}: truth obj-days ${T}; candidates hit ${sum(t.map((x) => x.candHit))} (${f2((100 * sum(t.map((x) => x.candHit))) / T)}%); truth (obj,10-min) slices ${sum(t.map((x) => x.slices))}, in a candidate period ${sum(t.map((x) => x.sliceHit))}; union-refine hit ${sum(t.map((x) => x.refineHit))} (${f2((100 * sum(t.map((x) => x.refineHit))) / T)}%)`);
      }
      const ur = withTruth.map((r) => r.q[q].union);
      log(`refine positives on truth days ${sum(ur.map((x) => x.positives))} object-days / ${sum(ur.map((x) => x.passes))} passes`);
    }
    // 1,826-day extrapolation
    log(`-- 1,826-day extrapolation (linear in days from these ${rs.length}): per variant`);
    for (const g of GRANS) for (const o of STAR_ORDERS) {
      const c = rs.map((r) => r.q[q].cfgs.find((x) => x.gran === g.name && x.order === o)!);
      const mergeS = sum(c.map((x) => x.mergeS + x.openS)), cand = sum(c.map((x) => x.candObjDays));
      const tim = c.filter((x) => x.refineS !== undefined);
      const refPerCand = tim.length ? sum(tim.map((x) => x.refineS!)) / sum(tim.map((x) => x.candObjDays)) : NaN;
      log(`${g.name.padEnd(5)} ${o}: merge+open ${f1((mergeS * D5) / rs.length)} s; candidates ${f1((cand * D5) / rs.length / 1e6)} M obj-days; refine ${f1((cand * D5 / rs.length * refPerCand) / 3600)} h on ${WORKERS} cores (${f2(refPerCand * 1000)} ms per candidate obj-day wall)`);
    }
  }
}

// ---------------------------------------------------------------- main
async function main(): Promise<void> {
  const box = pickBox();
  log(`box B (order 3) key ${box.key}: alt ${(box.rLo - WGS84_A_KM).toFixed(0)}..${(box.rHi - WGS84_A_KM).toFixed(0)} km, half-width ${(box.hwRad * DEG).toFixed(2)} deg, ${box.count} objects on ${allDays[allDays.length - 1]!.day}`);
  writeFileSync(Q_DIR + 'box.json', JSON.stringify(box));
  if (stage === 'report') { report(box); return; }
  const pool = new Pool(WORKERS); pool.start();
  if (stage === 'truth') {
    const want = (a.get('truth-days') ?? allDays[allDays.length - 1]!.day).split(',');
    for (const day of want) {
      const d = allDays.find((x) => x.day === day)!;
      const t = await runTruth(pool, d, box);
      const cnt = (x: Uint16Array) => { let o = 0, p = 0; for (const v of x) { if (v) o++; p += v; } return `${o} object-days / ${p} passes`; };
      log(`truth ${day}: wall ${t.wallS.toFixed(1)} s, ${(t.propCalls / 1e6).toFixed(0)}M SGP4 calls; India ${cnt(t.india)}; box ${cnt(t.box)}`);
    }
  } else if (stage === 'query') {
    const k = Number(a.get('timing-days') ?? 3);
    const timingDays = new Set<number>(); for (let j = 0; j < k; j++) timingDays.add(Math.round((j * (days.length - 1)) / Math.max(1, k - 1)));
    for (let di = 0; di < days.length; di++) {
      const d = days[di]!;
      if (existsSync(dayResFile(d.day)) && !a.has('force')) { log(`${d.day} cached`); continue; }
      const t0 = performance.now();
      const r = await doDay(pool, d, di, box, timingDays);
      log(`${d.day}: ${secs(t0).toFixed(1)} s${r.timing ? ' (timing day)' : ''}; india union ${r.q.india.union.positives} obj-days/${r.q.india.union.passes} passes (refine ${r.q.india.union.wallS.toFixed(1)} s); box ${r.q.box.union.positives}/${r.q.box.union.passes} (${r.q.box.union.wallS.toFixed(1)} s)`);
    }
    report(box);
  }
  await pool.close();
}

await main();
