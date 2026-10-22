// ============================================================
// SPIKE — not production. Two follow-ups on the Layer 2 daily summaries (one day, 2026-10-18 by default):
//  A. how many distinct cells does one object visit per day (by regime), from the stored daily file
//  B. what if summaries were kept per HOUR: size, and Q-L1 (India) candidate count + refine cost
//
//   npx tsx packages/backend/scripts/starmap/coverage-hourly.ts [--day 2026-10-18] [--stage stats|hourly|all]
// ============================================================
import { readFileSync } from 'node:fs';
import { loadCatalog, parseArgs } from './catalog.js';
import { Pool, COVERAGE_DIR, HISTORY_DIR, DAY_MS, FENCED, coverPolygon } from './coverage-lib.js';
import { readCoverage, forEachId, findCell, writeCoverage, FRAME_EARTH } from './coverage-codec.js';
import type { BuildTask, BuildOut, RefineTask, RefineOut } from './coverage-worker.js';

const a = parseArgs(process.argv.slice(2));
const day = a.get('day') ?? '2026-10-18';
const stage = a.get('stage') ?? 'all';
const startMs = Date.parse(day + 'T00:00:00Z');
const log = (...x: unknown[]) => console.log(...x);
const f1 = (x: number) => x.toFixed(1);
const REG = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];
const cat = loadCatalog(`${HISTORY_DIR}catalog-${day}.json`);

function statsA(): void {
  log(`== A. distinct cells visited per object per day (${day}, from the stored daily file)`);
  const cov = readCoverage(new Uint8Array(readFileSync(`${COVERAGE_DIR}${day}.bin`)));
  for (const cfg of cov.configs) {
    const per = new Uint32Array(cov.n);
    let maxList = 0, lists = 0, totalPairs = 0;
    for (let i = 0; i < cfg.cells.length; i++) {
      let n = 0;
      forEachId(cov.buf, cfg.offs[i]!, cfg.lens[i]!, cfg.tags[i]!, (id) => { per[id]!++; n++; });
      maxList = Math.max(maxList, n); lists++; totalPairs += n;
    }
    const totalCells = cfg.frame === FRAME_EARTH ? 12 * 4 ** cfg.order : cfg.cells.length;
    const name = `${cfg.frame === FRAME_EARTH ? 'earth' : 'star'}${cfg.order}`;
    const parts: string[] = [];
    for (const reg of REG) {
      const v: number[] = [];
      for (let i = 0; i < cat.length; i++) if (cat[i]!.regime === reg && per[i]! > 0 && !FENCED.has(cat[i]!.noradId)) v.push(per[i]!);
      if (!v.length) continue;
      v.sort((x, y) => x - y);
      parts.push(`${reg} mean ${f1(v.reduce((s, x) => s + x, 0) / v.length)} med ${v[v.length >> 1]} p99 ${v[Math.floor(v.length * 0.99)]} (n=${v.length})`);
    }
    log(`${name}: ${cfg.cells.length} non-empty cells (${cfg.frame === FRAME_EARTH ? `of ${totalCells} total` : 'of those ever visited'}), avg list ${f1(totalPairs / lists)} objects (${f1((100 * totalPairs) / lists / cov.n)}% of catalog), longest list ${maxList}`);
    log(`   cells per object per day: ${parts.join(' | ')}`);
    if (cfg.frame === FRAME_EARTH) {
      const leo: number[] = []; for (let i = 0; i < cat.length; i++) if (cat[i]!.regime === 'LEO' && per[i]! > 0) leo.push(per[i]!);
      log(`   LEO objects touch on average ${f1((100 * leo.reduce((s, x) => s + x, 0)) / leo.length / totalCells)}% of all ${totalCells} ground cells in a day`);
    }
  }
}

class Lists {
  cells = new Map<number, { a: Uint16Array; n: number }>();
  add(cell: number, idx: number): void {
    let e = this.cells.get(cell);
    if (!e) { e = { a: new Uint16Array(4), n: 0 }; this.cells.set(cell, e); }
    if (e.n === e.a.length) { const b = new Uint16Array(e.a.length * 2); b.set(e.a); e.a = b; }
    e.a[e.n++] = idx;
  }
}

async function hourly(): Promise<void> {
  log(`\n== B. hourly summaries (${day}, Earth frame only; same runs, split by hour)`);
  const pool = new Pool(5); pool.start();
  const t0 = performance.now();
  const lists = [new Lists(), new Lists(), new Lists()];
  const tasks: BuildTask[] = [];
  for (let b = 0; b < cat.length; b += 200) tasks.push({ kind: 'build', hourly: true, omms: cat.slice(b, b + 200).map((o) => o.omm), startMs, endMs: startMs + DAY_MS, stepMs: 20_000 });
  await pool.map<BuildOut>(tasks, (r, ti) => {
    const base = ti * 200; const bad = new Set(r.skips.map((s) => s[0]));
    const off = [0, 0, 0];
    for (let i = 0; i < r.counts[3]!.length; i++) {
      for (let c = 0; c < 3; c++) {
        const n = r.counts[3 + c]![i]!;
        if (!FENCED.has(cat[base + i]!.noradId) && !bad.has(i)) for (let k = 0; k < n; k++) lists[c]!.add(r.cells[3 + c]![off[c]! + k]!, base + i);
        off[c]! += n;
      }
    }
  });
  log(`hourly build wall ${f1((performance.now() - t0) / 1000)} s (shared load)`);
  const orders = [4, 5, 6];
  const cfgs = orders.map((order, c) => {
    const m = new Map<number, Uint16Array>();
    for (const [k, e] of lists[c]!.cells) { const s = e.a.subarray(0, e.n); s.sort(); m.set(k, s); }
    return { frame: FRAME_EARTH, order, cells: m };
  });
  const { stats } = writeCoverage(startMs, cat.map((o) => o.noradId), cfgs);
  const daily = readCoverage(new Uint8Array(readFileSync(`${COVERAGE_DIR}${day}.bin`)));
  void daily;
  for (let c = 0; c < 3; c++) {
    const s = stats[c]!;
    log(`earth${orders[c]} hourly: ${s.nCells} (cell,hour) lists, ${s.nPairs} pairs (${f1(s.nPairs / 24 / cat.length)} cells per object per hour), ${((s.payloadBytes + s.dirBytes) / 1e6).toFixed(1)} MB (dir ${(s.dirBytes / 1e6).toFixed(1)} MB), bitmap lists ${s.bitmapLists}`);
  }
  // candidates for India
  const cand: Uint8Array[][] = [];
  for (let c = 0; c < 3; c++) {
    const order = orders[c]!; const cover = coverPolygon(order);
    const marks = Array.from({ length: 24 }, () => new Uint8Array(cat.length));
    const tm = performance.now();
    for (let h = 0; h < 24; h++) for (const cell of cover) { const l = cfgs[c]!.cells.get(cell * 24 + h); if (l) for (let k = 0; k < l.length; k++) marks[h]![l[k]!] = 1; }
    const ms = performance.now() - tm;
    let hourPairs = 0; const dayMark = new Uint8Array(cat.length);
    for (let h = 0; h < 24; h++) for (let i = 0; i < cat.length; i++) if (marks[h]![i]) { hourPairs++; dayMark[i] = 1; }
    const dayPairs = dayMark.reduce((s, x) => s + x, 0);
    log(`India order ${order}: candidates ${hourPairs} (object,hour) pairs = ${f1(hourPairs / dayPairs)} hours per candidate object; ${dayPairs} candidate objects/day (same as daily lists) | merge ${f1(ms)} ms in memory`);
    cand.push(marks);
  }
  // refine hourly candidates at order 6, windows of 1 h
  const marks6 = cand[2]!;
  const items: Array<{ i: number; h: number }> = [];
  for (let h = 0; h < 24; h++) for (let i = 0; i < cat.length; i++) if (marks6[h]![i]) items.push({ i, h });
  const rt: RefineTask[] = [];
  for (let b = 0; b < items.length; b += 200) {
    rt.push({ kind: 'refine', mode: 'poly', boxOrder: 3, boxKey: 0, stepMs: 20_000,
      items: items.slice(b, b + 200).map((it) => ({ omm: cat[it.i]!.omm, startMs: startMs + it.h * 3_600_000, endMs: startMs + (it.h + 1) * 3_600_000 })) });
  }
  const tr = performance.now();
  const res = await pool.map<RefineOut>(rt);
  const refineH = (performance.now() - tr) / 1000;
  let pos = 0, passes = 0; const posObj = new Set<number>();
  res.forEach((r, ti) => r.intervals.forEach((iv, k) => { if (iv.length) { pos++; passes += iv.length / 2; posObj.add(items[ti * 200 + k]!.i); } }));
  log(`REFINE hourly order-6 candidates: ${items.length} (object,hour) windows in ${f1(refineH)} s (5 workers, shared load) -> ${pos} positive object-hours (precision ${f1((100 * pos) / items.length)}%), ${posObj.size} objects, ${passes} pass pieces`);
  // the daily candidates of the same day, refined for comparison
  const dayItems: number[] = []; const dm = new Uint8Array(cat.length);
  for (const it of items) dm[it.i] = 1; dm.forEach((v, i) => { if (v) dayItems.push(i); });
  const rd: RefineTask[] = [];
  for (let b = 0; b < dayItems.length; b += 100) rd.push({ kind: 'refine', mode: 'poly', boxOrder: 3, boxKey: 0, stepMs: 20_000, items: dayItems.slice(b, b + 100).map((i) => ({ omm: cat[i]!.omm, startMs, endMs: startMs + DAY_MS })) });
  const td = performance.now();
  const resD = await pool.map<RefineOut>(rd);
  const refineD = (performance.now() - td) / 1000;
  let posD = 0; resD.forEach((r) => r.intervals.forEach((iv) => { if (iv.length) posD++; }));
  log(`REFINE daily order-6 candidates (same day): ${dayItems.length} object-days in ${f1(refineD)} s -> ${posD} positive objects; hourly refine is ${f1(refineD / refineH)}x faster, ${posD === posObj.size ? 'same answer' : `objects differ: daily ${posD} vs hourly ${posObj.size}`}`);
  await pool.close();
}

if (stage === 'stats' || stage === 'all') statsA();
if (stage === 'hourly' || stage === 'all') await hourly();
void findCell;
