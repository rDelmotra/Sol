// ============================================================
// SPIKE — not production. Layer 2 queries over the daily coverage files.
//
//   npx tsx packages/backend/scripts/starmap/coverage-query.ts [--stage all|setup|truth|l1|l2|l3] [--refine-orders 6] ...
//
// Q-L1  who passed over India in the last 29 days   (Earth frame, cover polygon -> merge -> refine)
// Q-L2  who passed through star-map box B           (TEME frame, orders 2/3/4 around B -> merge -> refine)
// TRUTH brute force over the most recent 7 days at 10 s sampling.
// Q-L3  orbit-shape shortcut vs truth / coverage.
// Intermediate results are cached as JSON in data/coverage/ (gitignored).
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cellCentre, decodeKey, pix2angNest, SHELL_DELTA0, WGS84_A_KM, DEG, RAD } from '@orbitwatch/orbital-core';
import { loadCatalog, parseArgs, type CatObj } from './catalog.js';
import {
  Pool, dailyDays, COVERAGE_DIR, DAY_MS, FENCED, coverPolygon, inPoly, subPoint,
  POLY_LAT_MIN, POLY_LAT_MAX, POLY_LON_MIN, POLY_LON_MAX, type DayInfo,
} from './coverage-lib.js';
import { readCoverage, findCell, forEachId, FRAME_STAR, FRAME_EARTH, type CoverageDay } from './coverage-codec.js';
import { makeProp } from './runs.js';
import type { RefineTask, RefineOut, TruthTask, TruthOut } from './coverage-worker.js';
import * as satellite from 'satellite.js';

const a = parseArgs(process.argv.slice(2));
const stage = a.get('stage') ?? 'all';
const pool = new Pool(5);
const days = dailyDays().slice(-Number(a.get('ndays') ?? 29));
const truthDays = days.slice(-Math.min(7, days.length));
const secs = (t0: number) => (performance.now() - t0) / 1000;
const f2 = (x: number) => x.toFixed(2);
const log = (...x: unknown[]) => console.log(...x);

// ---------- merge: cover cells -> candidate marks per day ----------
interface MergeResult { marks: Uint8Array[]; mergeS: number; openS: number; bytesTouched: number; listsRead: number; idsDecoded: number }
function mergeCover(frame: number, order: number, cover: number[], dayList: DayInfo[]): MergeResult {
  const marks: Uint8Array[] = [];
  let mergeS = 0, openS = 0, bytes = 0, lists = 0, ids = 0;
  for (const d of dayList) {
    const t0 = performance.now();
    const cov: CoverageDay = readCoverage(new Uint8Array(readFileSync(`${COVERAGE_DIR}${d.day}.bin`)));
    openS += secs(t0);
    const cfg = cov.configs.find((c) => c.frame === frame && c.order === order)!;
    const t1 = performance.now();
    const mark = new Uint8Array(cov.n);
    for (const cell of cover) {
      const i = findCell(cfg, cell);
      if (i < 0) continue;
      lists++; bytes += cfg.lens[i]!;
      forEachId(cov.buf, cfg.offs[i]!, cfg.lens[i]!, cfg.tags[i]!, (id) => { mark[id] = 1; ids++; });
    }
    mergeS += secs(t1);
    marks.push(mark);
  }
  return { marks, mergeS, openS, bytesTouched: bytes, listsRead: lists, idsDecoded: ids };
}
const countMarks = (m: Uint8Array[]) => m.reduce((s, x) => { let c = 0; for (let i = 0; i < x.length; i++) c += x[i]!; return s + c; }, 0);

// ---------- box B ----------
interface Box { order: 3; key: number; rLo: number; rHi: number; zMin: number; zMax: number; halfWidthDeg: number; centre: { x: number; y: number; z: number }; count: number }
function pickBox(): Box {
  const last = readCoverage(new Uint8Array(readFileSync(`${COVERAGE_DIR}${days[days.length - 1]!.day}.bin`)));
  const cfg = last.configs.find((c) => c.frame === FRAME_STAR && c.order === 3)!;
  let best = -1, bestN = -1;
  for (let i = 0; i < cfg.cells.length; i++) {
    const c = cellCentre(3, cfg.cells[i]!);
    const r = Math.hypot(c.x, c.y, c.z);
    if (r > WGS84_A_KM + 2000) continue; // LEO shells only
    let n = 0; forEachId(last.buf, cfg.offs[i]!, cfg.lens[i]!, cfg.tags[i]!, () => n++);
    if (n > bestN) { bestN = n; best = cfg.cells[i]!; }
  }
  const { pix, nk } = decodeKey(3, best);
  const rLo = WGS84_A_KM * Math.exp((nk * SHELL_DELTA0) / 8), rHi = WGS84_A_KM * Math.exp(((nk + 1) * SHELL_DELTA0) / 8);
  // direction extent: sample 4^4 sub-pixels at order 7
  let zMin = 2, zMax = -2; const cen = pix2angNest(3, pix);
  const cs = Math.sqrt(1 - cen.z * cen.z), cd = [cs * Math.cos(cen.phi), cs * Math.sin(cen.phi), cen.z];
  let hw = 0;
  for (let q = 0; q < 4 ** 4; q++) {
    const s = pix2angNest(7, pix * 4 ** 4 + q), ss = Math.sqrt(1 - s.z * s.z);
    zMin = Math.min(zMin, s.z); zMax = Math.max(zMax, s.z);
    const dot = cd[0]! * ss * Math.cos(s.phi) + cd[1]! * ss * Math.sin(s.phi) + cd[2]! * s.z;
    hw = Math.max(hw, Math.acos(Math.min(1, dot)));
  }
  return { order: 3, key: best, rLo, rHi, zMin, zMax, halfWidthDeg: hw * DEG, centre: cellCentre(3, best), count: bestN };
}

// ---------- refine ----------
interface RefineRes { pairs: number; positives: number; passes: number; refineS: number; propCalls: number; loadS: number; pos: Uint8Array[]; passCount: Uint16Array[] }
async function refineCandidates(mode: 'poly' | 'box', boxOrder: number, boxKey: number, dayList: DayInfo[], marks: Uint8Array[]): Promise<RefineRes> {
  let refineS = 0, loadS = 0, propCalls = 0, pairs = 0, positives = 0, passes = 0;
  const pos: Uint8Array[] = [], passCount: Uint16Array[] = [];
  for (let di = 0; di < dayList.length; di++) {
    const d = dayList[di]!;
    const t0 = performance.now();
    const cat = loadCatalog(d.path);
    loadS += secs(t0);
    const idxs: number[] = []; marks[di]!.forEach((m, i) => { if (m) idxs.push(i); });
    const tasks: RefineTask[] = [];
    for (let b = 0; b < idxs.length; b += 100) {
      tasks.push({ kind: 'refine', mode, boxOrder, boxKey, stepMs: 20_000,
        items: idxs.slice(b, b + 100).map((i) => ({ omm: cat[i]!.omm, startMs: d.startMs, endMs: d.startMs + DAY_MS })) });
    }
    const t1 = performance.now();
    const res = await pool.map<RefineOut>(tasks);
    refineS += secs(t1);
    const p = new Uint8Array(cat.length), pc = new Uint16Array(cat.length);
    res.forEach((r, ti) => {
      propCalls += r.propCalls;
      r.intervals.forEach((iv, k) => {
        const idx = idxs[ti * 100 + k]!; pairs++;
        if (iv.length) { p[idx] = 1; positives++; pc[idx] = iv.length / 2; passes += iv.length / 2; }
      });
    });
    pos.push(p); passCount.push(pc);
  }
  return { pairs, positives, passes, refineS, propCalls, loadS, pos, passCount };
}

// ---------- truth ----------
interface Truth { india: Uint16Array[]; box: Uint16Array[]; wallS: number; propCalls: number }
async function runTruth(box: Box): Promise<Truth> {
  const cache = `${COVERAGE_DIR}truth-${truthDays[0]!.day}-${box.key}.json`;
  if (existsSync(cache)) {
    const j = JSON.parse(readFileSync(cache, 'utf8')) as { india: number[][]; box: number[][]; wallS: number; propCalls: number };
    return { india: j.india.map((x) => Uint16Array.from(x)), box: j.box.map((x) => Uint16Array.from(x)), wallS: j.wallS, propCalls: j.propCalls };
  }
  const t0 = performance.now();
  const india: Uint16Array[] = [], boxA: Uint16Array[] = []; let propCalls = 0;
  for (const d of truthDays) {
    const cat = loadCatalog(d.path);
    const tasks: TruthTask[] = [];
    for (let b = 0; b < cat.length; b += 400) {
      tasks.push({ kind: 'truth', omms: cat.slice(b, b + 400).map((o) => o.omm), startMs: d.startMs, stepMs: 10_000, boxOrder: 3, boxKey: box.key });
    }
    const res = await pool.map<TruthOut>(tasks);
    const ind = new Uint16Array(cat.length), bx = new Uint16Array(cat.length);
    res.forEach((r, ti) => { ind.set(r.india, ti * 400); bx.set(r.box, ti * 400); propCalls += r.propCalls; });
    for (let i = 0; i < cat.length; i++) if (FENCED.has(cat[i]!.noradId)) { ind[i] = 0; bx[i] = 0; }
    india.push(ind); boxA.push(bx);
    log(`  truth ${d.day} done (${f2(secs(t0))} s)`);
  }
  const wallS = secs(t0);
  writeFileSync(cache, JSON.stringify({ india: india.map((x) => [...x]), box: boxA.map((x) => [...x]), wallS, propCalls }));
  return { india, box: boxA, wallS, propCalls };
}

// ---------- reporting helpers ----------
function recallPrecision(marks: Uint8Array[], truth: Uint16Array[], positives?: Uint8Array[]) {
  // marks/positives are over all 29 days; truth covers the last 7
  const off = days.length - truthDays.length;
  let tp = 0, truthN = 0, cand = 0, missed: string[] = [], candPos = 0;
  for (let k = 0; k < truthDays.length; k++) {
    const m = marks[off + k]!, t = truth[k]!;
    for (let i = 0; i < t.length; i++) {
      if (m[i]) cand++;
      if (t[i]) { truthN++; if (m[i]) tp++; else if (missed.length < 5) missed.push(`${truthDays[k]!.day}#${i}`); }
      if (positives && m[i] && positives[off + k]![i]) candPos++;
    }
  }
  return { truthN, tp, cand, recall: truthN ? tp / truthN : NaN, precisionTruth: cand ? tp / cand : NaN, precisionRefine: positives && cand ? candPos / cand : NaN, missed };
}

function boxPlaneShortcut() { return null; }
void boxPlaneShortcut;

// ============================================================
async function main(): Promise<void> {
  pool.start();
  const box = pickBox();
  log(`box B (order 3) key ${box.key}: r ${f2(box.rLo)}..${f2(box.rHi)} km (alt ${f2(box.rLo - WGS84_A_KM)}..${f2(box.rHi - WGS84_A_KM)}), centre z/r ${f2(box.centre.z / Math.hypot(box.centre.x, box.centre.y, box.centre.z))}, ${box.count} objects on ${days[days.length - 1]!.day}`);
  const res: Record<string, unknown> = { box: { key: box.key, rLo: box.rLo, rHi: box.rHi } };

  log(`\n== TRUTH: brute force, ${truthDays.length} days (${truthDays[0]!.day}..${truthDays[6]!.day}), 10 s sampling, all objects`);
  const truth = await runTruth(box);
  const sum = (x: Uint16Array[]) => x.reduce((s, a2) => { let c = 0; for (let i = 0; i < a2.length; i++) c += a2[i]! > 0 ? 1 : 0; return s + c; }, 0);
  const sumPass = (x: Uint16Array[]) => x.reduce((s, a2) => { let c = 0; for (let i = 0; i < a2.length; i++) c += a2[i]!; return s + c; }, 0);
  log(`truth wall ${f2(truth.wallS)} s, ${truth.propCalls} SGP4 calls; India object-days ${sum(truth.india)} (${sumPass(truth.india)} passes); box B object-days ${sum(truth.box)} (${sumPass(truth.box)} passes)`);
  if (stage === 'truth') { await pool.close(); return; }

  // ----- Q-L1 -----
  const refOrders = (a.get('refine-orders') ?? '6').split(',').map(Number);
  let l1pos: Uint8Array[] | undefined;
  let l2pos: Uint8Array[] | undefined;
  if (stage === 'all' || stage === 'l1') {
    log(`\n== Q-L1  India, last ${days.length} days`);
    const merged = new Map<number, MergeResult & { cover: number }>();
    for (const order of [4, 5, 6]) {
      const tc = performance.now();
      const cover = coverPolygon(order);
      const coverS = secs(tc);
      const m = mergeCover(FRAME_EARTH, order, cover, days);
      merged.set(order, { ...m, cover: cover.length });
      const rp = recallPrecision(m.marks, truth.india);
      log(`order ${order}: cover ${cover.length} cells (${f2(coverS)} s) | open+dir parse ${f2(m.openS)} s, merge ${f2(m.mergeS)} s (${m.listsRead} lists, ${(m.bytesTouched / 1e6).toFixed(1)} MB payload, ${m.idsDecoded} ids) | candidates ${countMarks(m.marks)} obj-days`);
      log(`   7-day recall vs truth ${(rp.recall * 100).toFixed(3)}% (${rp.tp}/${rp.truthN}), precision vs truth ${(rp.precisionTruth * 100).toFixed(1)}%, missed ${rp.missed.join(',') || 'none'}`);
    }
    const ro = Math.max(...refOrders);
    const r = await refineCandidates('poly', 3, box.key, days, merged.get(ro)!.marks);
    l1pos = r.pos;
    const off = days.length - truthDays.length;
    let rt = 0, tt = 0, extra = 0, p7 = 0, pass7 = 0;
    for (let k = 0; k < truthDays.length; k++) for (let i = 0; i < truth.india[k]!.length; i++) { const p = r.pos[off + k]![i]!, t = truth.india[k]![i]! > 0 ? 1 : 0; if (t && p) rt++; if (t) tt++; if (p && !t) extra++; p7 += p; pass7 += r.passCount[off + k]![i]!; }
    log(`REFINE of order-${ro} candidates (${pool.size} workers): ${r.pairs} obj-days in ${f2(r.refineS)} s (elements load ${f2(r.loadS)} s not counted; ${r.propCalls} SGP4 calls) -> ${r.positives} positive obj-days, ${r.passes} passes over ${days.length} d`);
    log(`7-day cross-check: refine ${p7} obj-days / ${pass7} passes vs truth ${tt} obj-days / ${sumPass(truth.india)} passes; truth∩refine ${rt}; refine-only (clips < 10 s) ${extra}`);
    const msPer = (r.refineS * 1000 * pool.size) / r.pairs;
    log(`refine cost ${f2(msPer)} ms per candidate obj-day per core (workers busy-time estimate, shared load)`);
    for (const order of [4, 5, 6]) {
      const m = merged.get(order)!;
      const cand = countMarks(m.marks);
      let pos = 0; for (let d = 0; d < days.length; d++) for (let i = 0; i < m.marks[d]!.length; i++) if (m.marks[d]![i] && r.pos[d]![i]) pos++;
      const total = m.mergeS + (order === ro ? r.refineS : (cand * msPer) / 1000 / pool.size);
      log(`  order ${order}: cand ${cand}, positives found ${pos}, precision ${(100 * pos / cand).toFixed(1)}%, merge ${f2(m.mergeS)} s, refine ${order === ro ? f2(r.refineS) : f2((cand * msPer) / 1000 / pool.size) + ' (est.)'} s, total ${f2(total)} s`);
    }
    // 5-year extrapolation (linear in days; merge scales with the number of day files, refine with candidates)
    const D5 = 1826;
    log(`5-YEAR EXTRAPOLATION of Q-L1 (x${(D5 / days.length).toFixed(1)} the ${days.length}-day measurement):`);
    for (const order of [4, 5, 6]) {
      const m = merged.get(order)!;
      const cand = countMarks(m.marks);
      const sc = D5 / days.length;
      log(`  order ${order}: merge ${f2(m.mergeS * sc)} s CPU (${(m.bytesTouched * sc / 1e9).toFixed(1)} GB of lists read + directories), candidates ${(cand * sc / 1e6).toFixed(1)} M obj-days -> refine ${(cand * sc * msPer / 1000 / 3600).toFixed(1)} core-hours (${(cand * sc * msPer / 1000 / 3600 / 10).toFixed(1)} h on 10 cores)`);
    }
    // positives as sets of objects, for Q-L3
    res.l1 = { refineS: r.refineS, pairs: r.pairs, positives: r.positives, passes: r.passes, msPerCandidate: msPer };
  }
  // ----- Q-L2 -----
  if (stage === 'all' || stage === 'l2') {
    const bigKids = box.key * 8; // placeholder for child C chosen below
    void bigKids;
    log(`\n== Q-L2  star-map box B (order-3 key ${box.key}), last ${days.length} days`);
    const covers: Record<number, number[]> = { 2: [Math.floor(box.key / 8)], 3: [box.key], 4: Array.from({ length: 8 }, (_, c) => box.key * 8 + c) };
    const merged = new Map<number, MergeResult>();
    for (const order of [2, 3, 4]) {
      const m = mergeCover(FRAME_STAR, order, covers[order]!, days);
      merged.set(order, m);
      const rp = recallPrecision(m.marks, truth.box);
      log(`order ${order}: cover ${covers[order]!.length} cell(s) | open+dir parse ${f2(m.openS)} s, merge ${f2(m.mergeS)} s (${m.listsRead} lists, ${(m.bytesTouched / 1e6).toFixed(2)} MB) | candidates ${countMarks(m.marks)} obj-days`);
      log(`   7-day recall vs truth ${(rp.recall * 100).toFixed(3)}% (${rp.tp}/${rp.truthN}), precision vs truth ${(rp.precisionTruth * 100).toFixed(1)}%, missed ${rp.missed.join(',') || 'none'}`);
    }
    // refine the order-2 candidate set (superset of all): gives positives for every order, and its own cost
    const r2 = await refineCandidates('box', 3, box.key, days, merged.get(2)!.marks);
    const r3 = await refineCandidates('box', 3, box.key, days, merged.get(3)!.marks);
    l2pos = r3.pos;
    const off = days.length - truthDays.length;
    let rt = 0, tt = 0, extra = 0, p7 = 0;
    for (let k = 0; k < truthDays.length; k++) for (let i = 0; i < truth.box[k]!.length; i++) { const p = r3.pos[off + k]![i]!, t = truth.box[k]![i]! > 0 ? 1 : 0; if (t && p) rt++; if (t) tt++; if (p && !t) extra++; p7 += p; }
    log(`REFINE order-3 candidates: ${r3.pairs} obj-days in ${f2(r3.refineS)} s (${r3.propCalls} SGP4 calls) -> ${r3.positives} positive obj-days, ${r3.passes} passes over ${days.length} d; total query ${f2(merged.get(3)!.mergeS + r3.refineS)} s`);
    log(`REFINE order-2 candidates: ${r2.pairs} obj-days in ${f2(r2.refineS)} s -> ${r2.positives} positive obj-days (same answer: ${r2.positives === r3.positives}); total query ${f2(merged.get(2)!.mergeS + r2.refineS)} s`);
    log(`7-day cross-check: refine ${p7} obj-days vs truth ${tt}; truth∩refine ${rt}; refine-only ${extra}`);
    for (const order of [2, 3, 4]) {
      const m = merged.get(order)!; const cand = countMarks(m.marks);
      let pos = 0; for (let d = 0; d < days.length; d++) for (let i = 0; i < m.marks[d]!.length; i++) if (m.marks[d]![i] && r3.pos[d]![i]) pos++;
      log(`  order ${order}: cand ${cand}, positives ${pos}, precision ${(100 * pos / cand).toFixed(1)}%, merge ${f2(m.mergeS)} s`);
    }
  }
  // ----- Q-L3 -----
  if (stage === 'all' || stage === 'l3') {
    await q3(box, truth, l1pos, l2pos);
  }
  writeFileSync(`${COVERAGE_DIR}query-results.json`, JSON.stringify(res, null, 1));
  await pool.close();
}

// ---------- Q-L3: orbit-shape shortcut ----------
const MU = 398600.4418, J2 = 1.08262668e-3, RE = 6378.137;
interface El { inc: number; raan: number; e: number; nRevDay: number; a: number; rp: number; ra: number; epochMs: number }
function elOf(o: CatObj): El | null {
  const m = o.omm as Record<string, number | string>;
  const n = Number(m.MEAN_MOTION), e = Number(m.ECCENTRICITY), inc = Number(m.INCLINATION), raan = Number(m.RA_OF_ASC_NODE);
  if (!(n > 0)) return null;
  const a = Math.cbrt(MU / ((n * 2 * Math.PI / 86400) ** 2));
  return { inc, raan, e, nRevDay: n, a, rp: a * (1 - e), ra: a * (1 + e), epochMs: Date.parse(String(m.EPOCH)) };
}
const maxLat = (inc: number) => (inc <= 90 ? inc : 180 - inc);
const isGeoLike = (el: El) => Math.abs(el.nRevDay - 1.0027) < 0.02 && el.e < 0.01;

/** India shortcut. `lonDay` = sub-satellite longitude at day midpoint (used only for GEO-like). */
function shortcutIndia(el: El, lonDay: number | null): boolean {
  if (maxLat(el.inc) + 0.5 < POLY_LAT_MIN) return false;
  if (isGeoLike(el)) {
    if (lonDay === null) return true;
    const m = 5; // deg margin: GEO longitude drift/libration within a day
    return lonDay >= POLY_LON_MIN - m && lonDay <= POLY_LON_MAX + m;
  }
  return true;
}
const PAD_KM = 30, LAT_PAD = 0.5, PLANE_PAD_DEG = 1.0;
function shortcutBoxBand(el: El, box: Box): boolean {
  if (el.rp - PAD_KM > box.rHi || el.ra + PAD_KM < box.rLo) return false;
  const mL = maxLat(el.inc) + LAT_PAD;
  const dMin = Math.asin(box.zMin) * DEG, dMax = Math.asin(box.zMax) * DEG;
  const dist = dMin <= 0 && dMax >= 0 ? 0 : Math.min(Math.abs(dMin), Math.abs(dMax));
  return dist <= mL;
}
/** Plane test: box direction within (halfwidth + pad) of the orbit's great circle at any RAAN reached during the day. */
function shortcutBoxPlane(el: El, box: Box, dayStartMs: number): boolean {
  const p = el.a * (1 - el.e * el.e), n = el.nRevDay * 2 * Math.PI / 86400;
  const rate = -1.5 * J2 * (RE / p) ** 2 * n * Math.cos(el.inc * RAD); // rad/s
  const c = box.centre, cr = Math.hypot(c.x, c.y, c.z);
  const d = [c.x / cr, c.y / cr, c.z / cr];
  const lim = Math.sin((box.halfWidthDeg + PLANE_PAD_DEG) * RAD);
  const si = Math.sin(el.inc * RAD), ci = Math.cos(el.inc * RAD);
  for (let h = 0; h <= 24; h += 1) {
    const raan = el.raan * RAD + rate * ((dayStartMs + h * 3600_000 - el.epochMs) / 1000);
    const nx = si * Math.sin(raan), ny = -si * Math.cos(raan), nz = ci;
    if (Math.abs(d[0]! * nx + d[1]! * ny + d[2]! * nz) <= lim) return true;
  }
  return false;
}

async function q3(box: Box, truth: Truth, l1pos?: Uint8Array[], l2pos?: Uint8Array[]): Promise<void> {
  log(`\n== Q-L3  orbit-shape shortcut (elements only)`);
  const regimes = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];
  type Tab = Record<string, { tp: number; fn: number; fp: number; tn: number }>;
  const mk = (): Tab => Object.fromEntries([...regimes, 'ALL'].map((r) => [r, { tp: 0, fn: 0, fp: 0, tn: 0 }]));
  const add = (t: Tab, reg: string, pred: boolean, tr: boolean) => {
    for (const k of [reg, 'ALL']) { const c = t[k]!; if (pred && tr) c.tp++; else if (!pred && tr) c.fn++; else if (pred && !tr) c.fp++; else c.tn++; }
  };
  const tabs = { indiaTruthObj: mk(), indiaTruthDay: mk(), indiaCovObj: mk(), boxBandTruthObj: mk(), boxPlaneTruthObj: mk(), boxBandCovObj: mk(), boxPlaneCovObj: mk() };
  // per-object unions
  type Agg = { reg: string; shIndia7: boolean; trIndia7: boolean; shIndia29: boolean; covIndia29: boolean; shBand7: boolean; shPlane7: boolean; trBox7: boolean; shBand29: boolean; shPlane29: boolean; covBox29: boolean };
  const agg = new Map<number, Agg>();
  const get = (id: number, reg: string): Agg => { let g = agg.get(id); if (!g) { g = { reg, shIndia7: false, trIndia7: false, shIndia29: false, covIndia29: !l1pos, shBand7: false, shPlane7: false, trBox7: false, shBand29: false, shPlane29: false, covBox29: !l2pos }; agg.set(id, g); } return g; };
  const off = days.length - truthDays.length;
  for (let di = 0; di < days.length; di++) {
    const d = days[di]!, cat = loadCatalog(d.path);
    const inTruth = di >= off, k = di - off;
    for (let i = 0; i < cat.length; i++) {
      const o = cat[i]!; if (FENCED.has(o.noradId)) continue;
      const el = elOf(o); if (!el) continue;
      let lonDay: number | null = null;
      if (isGeoLike(el) && maxLat(el.inc) + 0.5 >= POLY_LAT_MIN) {
        const p = makeProp(o.omm);
        const pv = p ? satellite.sgp4(p.satrec, (d.startMs + DAY_MS / 2 - p.epochMs) / 60000) : null;
        if (pv && pv.position && typeof pv.position !== 'boolean') lonDay = subPoint(pv.position.x, pv.position.y, pv.position.z, d.startMs + DAY_MS / 2).lonDeg;
      }
      const sh = shortcutIndia(el, lonDay), band = shortcutBoxBand(el, box), plane = band && shortcutBoxPlane(el, box, d.startMs);
      const g = get(o.noradId, o.regime);
      g.shIndia29 ||= sh; g.shBand29 ||= band; g.shPlane29 ||= plane;
      if (l1pos && l1pos[di]![i]) g.covIndia29 = true;
      if (l2pos && l2pos[di]![i]) g.covBox29 = true;
      if (inTruth) {
        g.shIndia7 ||= sh; g.shBand7 ||= band; g.shPlane7 ||= plane;
        if (truth.india[k]![i]) g.trIndia7 = true;
        if (truth.box[k]![i]) g.trBox7 = true;
        add(tabs.indiaTruthDay, o.regime, sh, truth.india[k]![i]! > 0);
      }
    }
  }
  for (const g of agg.values()) {
    add(tabs.indiaTruthObj, g.reg, g.shIndia7, g.trIndia7);
    add(tabs.boxBandTruthObj, g.reg, g.shBand7, g.trBox7);
    add(tabs.boxPlaneTruthObj, g.reg, g.shPlane7, g.trBox7);
    if (l1pos) add(tabs.indiaCovObj, g.reg, g.shIndia29, g.covIndia29);
    if (l2pos) { add(tabs.boxBandCovObj, g.reg, g.shBand29, g.covBox29); add(tabs.boxPlaneCovObj, g.reg, g.shPlane29, g.covBox29); }
  }
  const print = (name: string, t: Tab) => {
    log(`-- ${name}`);
    log('   regime     truth+   FN   FP    TN   recall   precision');
    for (const r of [...regimes, 'ALL']) {
      const c = t[r]!; const pos = c.tp + c.fn;
      if (pos + c.fp + c.tn === 0) continue;
      log(`   ${r.padEnd(6)} ${String(pos).padStart(8)} ${String(c.fn).padStart(4)} ${String(c.fp).padStart(5)} ${String(c.tn).padStart(5)}   ${pos ? (100 * c.tp / pos).toFixed(2) + '%' : '  n/a'}   ${c.tp + c.fp ? (100 * c.tp / (c.tp + c.fp)).toFixed(1) + '%' : 'n/a'}`);
    }
  };
  print('India, per object, vs TRUTH (7 d)', tabs.indiaTruthObj);
  print('India, per object-day, vs TRUTH (7 d)', tabs.indiaTruthDay);
  if (l1pos) print('India, per object, vs COVERAGE+REFINE (all days run)', tabs.indiaCovObj);
  print('Box B, height+latitude band, per object, vs TRUTH (7 d)', tabs.boxBandTruthObj);
  print('Box B, band + orbit-plane distance, per object, vs TRUTH (7 d)', tabs.boxPlaneTruthObj);
  if (l2pos) { print('Box B, band, per object, vs COVERAGE+REFINE (all days run)', tabs.boxBandCovObj); print('Box B, band+plane, per object, vs COVERAGE+REFINE (all days run)', tabs.boxPlaneCovObj); }
}

await main();
void inPoly; void POLY_LAT_MAX;
