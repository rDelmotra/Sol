// ============================================================
// SPIKE — not production. Layer 2: build DAILY COVERAGE SUMMARIES.
//
// For each UTC day: one SGP4 pass per object (20 s step, box/cell changes bisected to ~1 s), recording
// which coarse cells it visited in two frames and storing the result INVERTED per (frame, order, cell):
//   star  frame : SpaceCell box in TEME, orders 2,3,4
//   Earth frame : HEALPix NESTED ground cell of the geodetic sub-satellite point, orders 4,5,6
// Coarser orders are derived exactly from the finest (octree/HEALPix parents), so one pass feeds all six.
//
//   npx tsx packages/backend/scripts/starmap/coverage.ts [--days daily|all|YYYY-MM-DD,...] [--workers 5]
//        [--limit N] [--force] [--out-dir dir]
// Writes data/coverage/<day>.bin and data/coverage/report.jsonl (one JSON line per day).
// ============================================================
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { loadCatalog, parseArgs, type CatObj } from './catalog.js';
import {
  Pool, listDays, dailyDays, COVERAGE_DIR, DAY_MS, FENCED, STAR_ORDERS, EARTH_ORDERS,
} from './coverage-lib.js';
import { writeCoverage, FRAME_STAR, FRAME_EARTH, type ConfigData } from './coverage-codec.js';
import type { BuildTask, BuildOut } from './coverage-worker.js';

const CHUNK = 200;
const STEP_MS = 20_000;
const CONFIGS: Array<[number, number]> = [
  ...STAR_ORDERS.map((o) => [FRAME_STAR, o] as [number, number]),
  ...EARTH_ORDERS.map((o) => [FRAME_EARTH, o] as [number, number]),
];

/** cell -> growable Uint16Array of object indices. */
class Lists {
  cells = new Map<number, { a: Uint16Array; n: number }>();
  add(cell: number, idx: number): void {
    let e = this.cells.get(cell);
    if (!e) { e = { a: new Uint16Array(4), n: 0 }; this.cells.set(cell, e); }
    if (e.n === e.a.length) { const b = new Uint16Array(e.a.length * 2); b.set(e.a); e.a = b; }
    e.a[e.n++] = idx;
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const which = a.get('days') ?? 'daily';
  const all = listDays();
  const days = which === 'daily' ? dailyDays() : which === 'all' ? all : all.filter((d) => which.split(',').includes(d.day));
  const outDir = a.get('out-dir') ?? COVERAGE_DIR;
  mkdirSync(outDir, { recursive: true });
  const limit = a.has('limit') ? Number(a.get('limit')) : Infinity;
  const pool = new Pool(Number(a.get('workers') ?? 5));
  pool.start();
  console.log(`building ${days.length} days with ${pool.size} workers (timings under shared load: another worker runs concurrently)`);

  for (const d of days) {
    const binPath = `${outDir}/${d.day}.bin`;
    if (existsSync(binPath) && !a.has('force')) { console.log(`${d.day} exists, skip`); continue; }
    const t0 = Date.now();
    const full: CatObj[] = loadCatalog(d.path);
    const cat = full.slice(0, limit);
    if (cat.length >= 65536) throw new Error('object index does not fit u16');
    const lists = CONFIGS.map(() => new Lists());
    const tasks: BuildTask[] = [];
    for (let b = 0; b < cat.length; b += CHUNK) {
      tasks.push({ kind: 'build', omms: cat.slice(b, b + CHUNK).map((o) => o.omm), startMs: d.startMs, endMs: d.startMs + DAY_MS, stepMs: STEP_MS });
    }
    const skipReasons = new Map<string, number>();
    const dropped: string[] = [];
    let propCalls = 0;
    const tLoad = Date.now() - t0;
    await pool.map<BuildOut>(tasks, (r, ti) => {
      const base = ti * CHUNK;
      propCalls += r.propCalls;
      const bad = new Set<number>();
      for (const [i, why] of r.skips) {
        bad.add(i);
        const k = why.startsWith('over-row-cap') ? 'over-row-cap' : why;
        skipReasons.set(k, (skipReasons.get(k) ?? 0) + 1);
        if (k === 'over-row-cap') dropped.push(`${cat[base + i]!.noradId}(${why.split(':')[1]})`);
      }
      const off = new Array<number>(6).fill(0);
      for (let i = 0; i < r.counts[0]!.length; i++) {
        const fenced = FENCED.has(cat[base + i]!.noradId);
        for (let c = 0; c < 6; c++) {
          const n = r.counts[c]![i]!;
          if (!fenced) for (let k = 0; k < n; k++) lists[c]!.add(r.cells[c]![off[c]! + k]!, base + i);
          off[c]! += n;
        }
      }
    });
    const tSgp = Date.now() - t0;
    const configs: ConfigData[] = CONFIGS.map(([frame, order], c) => {
      const m = new Map<number, Uint16Array>();
      for (const [cell, e] of lists[c]!.cells) { const s = e.a.subarray(0, e.n); s.sort(); m.set(cell, s); }
      return { frame, order, cells: m };
    });
    const { file, stats, noradBytes } = writeCoverage(d.startMs, cat.map((o) => o.noradId), configs);
    writeFileSync(binPath, file);
    const wall = (Date.now() - t0) / 1000;
    const rss = process.resourceUsage().maxRSS / 1024;
    const rec = {
      day: d.day, objects: cat.length, skipped: Object.fromEntries(skipReasons), dropped, fenced: [...FENCED],
      propCalls, wallS: +wall.toFixed(1), loadS: +(tLoad / 1000).toFixed(1), sgp4S: +((tSgp - tLoad) / 1000).toFixed(1),
      totalBytes: file.length, noradBytes, peakRssMB: Math.round(rss),
      configs: stats.map((s) => ({ frame: s.frame === FRAME_STAR ? 'star' : 'earth', order: s.order, cells: s.nCells, pairs: s.nPairs, dirBytes: s.dirBytes, payloadBytes: s.payloadBytes, bitmapLists: s.bitmapLists })),
    };
    appendFileSync(`${outDir}/report.jsonl`, JSON.stringify(rec) + '\n');
    console.log(`${d.day}: ${cat.length} objs, wall ${wall.toFixed(1)}s (sgp4 ${rec.sgp4S}s), ${(file.length / 1e6).toFixed(1)} MB, rss ${rec.peakRssMB} MB, skipped ${JSON.stringify(rec.skipped)}`);
    for (const s of rec.configs) console.log(`   ${s.frame}${s.order}: ${s.cells} cells, ${s.pairs} pairs, ${(s.payloadBytes + s.dirBytes) / 1e6} MB (dir ${(s.dirBytes / 1e6).toFixed(2)}), bitmap lists ${s.bitmapLists}`);
  }
  await pool.close();
}

await main();
