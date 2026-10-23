// ============================================================
// SPIKE — not production. Layer 2: build STAR-MAP coverage summaries, one UTC day at a time.
//
// For each day, using that day's own element sets: ONE SGP4 pass per object (20 s step, box changes
// bisected to ~1 s) in the star map (TEME) at order 4. From those runs we derive, for 3 granularities
// (whole day, each hour, each 10 minutes) and 3 orders (2, 3, 4; coarser orders are exact parents),
// the pairs (cell, period) -> objects, stored INVERTED: key = cell * periodsPerDay + period -> sorted
// list of object indices. One file per (day, granularity). There is no Earth-fixed cell system.
//
//   npx tsx packages/backend/scripts/starmap/coverage.ts [--days daily|weekly|all|YYYY-MM-DD,...]
//        [--workers 4] [--step 10] [--limit N] [--force] [--out-dir dir]
// Writes data/coverage/<day>.<gran>.bin and data/coverage/report.jsonl (one JSON line per day).
// ============================================================
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { loadCatalog, parseArgs, type CatObj } from './catalog.js';
import { Pool, listDays, dailyDays, weeklyDays, COVERAGE_DIR, DAY_MS, STAR_ORDERS, GRANS, ID_SHIFT } from './coverage-lib.js';
import { writeCoverage, type ConfigData } from './coverage-codec.js';
import type { BuildTask, BuildOut } from './coverage-worker.js';

const CHUNK = 200;

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const which = a.get('days') ?? 'daily';
  const all = listDays();
  const days = which === 'daily' ? dailyDays() : which === 'weekly' ? weeklyDays() : which === 'all' ? all : all.filter((d) => which.split(',').includes(d.day));
  const outDir = (a.get('out-dir') ?? COVERAGE_DIR).replace(/\/?$/, '/');
  mkdirSync(outDir, { recursive: true });
  const STEP_MS = Number(a.get('step') ?? 10) * 1000; // 10 s = the brute-force truth's own step (see STARMAP.md T1)
  const limit = a.has('limit') ? Number(a.get('limit')) : Infinity;
  const pool = new Pool(Number(a.get('workers') ?? 4));
  pool.start();
  console.log(`building ${days.length} days with ${pool.size} workers`);

  for (const d of days) {
    if (existsSync(`${outDir}${d.day}.m10.bin`) && !a.has('force')) { console.log(`${d.day} exists, skip`); continue; }
    const t0 = Date.now();
    const full: CatObj[] = loadCatalog(d.path);
    const cat = full.slice(0, limit);
    if (cat.length >= ID_SHIFT) throw new Error('object index does not fit u16');
    const tasks: BuildTask[] = [];
    for (let b = 0; b < cat.length; b += CHUNK) {
      const sl = cat.slice(b, b + CHUNK);
      tasks.push({ kind: 'build', omms: sl.map((o) => o.omm), norad: sl.map((o) => o.noradId), base: b, startMs: d.startMs, endMs: d.startMs + DAY_MS, stepMs: STEP_MS });
    }
    const tLoad = Date.now() - t0;
    const parts: Float64Array[][] = Array.from({ length: GRANS.length * STAR_ORDERS.length }, () => []);
    const skipReasons = new Map<string, number>();
    const dropped: string[] = [];
    let propCalls = 0;
    await pool.map<BuildOut>(tasks, (r, ti) => {
      propCalls += r.propCalls;
      r.pairs.forEach((arr, c) => parts[c]!.push(arr));
      for (const [i, why] of r.skips) {
        const k = why.startsWith('over-row-cap') ? 'over-row-cap' : why;
        skipReasons.set(k, (skipReasons.get(k) ?? 0) + 1);
        if (k === 'over-row-cap') dropped.push(`${cat[ti * CHUNK + i]!.noradId}(${why.split(':')[1]})`);
      }
    });
    const tSgp = Date.now() - t0;
    let tSort = 0, tEnc = 0;
    const gstats: Array<Record<string, unknown>> = [];
    for (let g = 0; g < GRANS.length; g++) {
      const configs: ConfigData[] = [];
      for (let o = 0; o < STAR_ORDERS.length; o++) {
        const c = g * STAR_ORDERS.length + o;
        const ts = Date.now();
        let n = 0; for (const p of parts[c]!) n += p.length;
        const flat = new Float64Array(n); let off = 0;
        for (const p of parts[c]!) { flat.set(p, off); off += p.length; }
        parts[c] = [];
        flat.sort();
        const ids = new Uint16Array(n);
        const m = new Map<number, Uint16Array>();
        let start = 0, curKey = n ? Math.floor(flat[0]! / ID_SHIFT) : 0;
        for (let i = 0; i < n; i++) {
          const key = Math.floor(flat[i]! / ID_SHIFT);
          ids[i] = flat[i]! - key * ID_SHIFT;
          if (key !== curKey) { m.set(curKey, ids.subarray(start, i)); start = i; curKey = key; }
        }
        if (n) m.set(curKey, ids.subarray(start, n));
        tSort += Date.now() - ts;
        configs.push({ gran: g, order: STAR_ORDERS[o]!, cells: m });
      }
      const te = Date.now();
      const { file, stats, noradBytes } = writeCoverage(d.startMs, cat.map((o) => o.noradId), configs);
      writeFileSync(`${outDir}${d.day}.${GRANS[g]!.name}.bin`, file);
      tEnc += Date.now() - te;
      gstats.push({
        gran: GRANS[g]!.name, fileBytes: file.length, noradBytes,
        orders: stats.map((s) => ({ order: s.order, lists: s.nCells, pairs: s.nPairs, dirBytes: s.dirBytes, payloadBytes: s.payloadBytes, bitmapLists: s.bitmapLists })),
      });
    }
    const wall = (Date.now() - t0) / 1000;
    const rss = process.resourceUsage().maxRSS / 1024;
    const rec = {
      day: d.day, stepS: STEP_MS / 1000, objects: cat.length, skipped: Object.fromEntries(skipReasons), dropped, workers: pool.size,
      propCalls, wallS: +wall.toFixed(1), loadS: +(tLoad / 1000).toFixed(1), sgp4S: +((tSgp - tLoad) / 1000).toFixed(1),
      sortS: +(tSort / 1000).toFixed(1), encodeS: +(tEnc / 1000).toFixed(1), peakRssMB: Math.round(rss), grans: gstats,
    };
    appendFileSync(`${outDir}report.jsonl`, JSON.stringify(rec) + '\n');
    console.log(`${d.day}: ${cat.length} objs, wall ${wall.toFixed(1)}s (sgp4 ${rec.sgp4S}s, sort ${rec.sortS}s, encode ${rec.encodeS}s), ${(propCalls / 1e6).toFixed(0)}M SGP4 calls, rss ${rec.peakRssMB} MB, skipped ${JSON.stringify(rec.skipped)}`);
    for (const g of gstats) console.log(`   ${g.gran}: ${((g.fileBytes as number) / 1e6).toFixed(2)} MB  ` + (g.orders as Array<{ order: number; lists: number; pairs: number; dirBytes: number; payloadBytes: number }>).map((s) => `o${s.order}: ${s.lists} lists, ${s.pairs} pairs, ${((s.dirBytes + s.payloadBytes) / 1e6).toFixed(2)} MB`).join(' | '));
  }
  await pool.close();
}

await main();
