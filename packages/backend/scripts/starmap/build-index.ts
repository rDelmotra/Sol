// ============================================================
// SPIKE — not production.
//
// Build the star-fixed spatio-temporal index for the whole catalog: for every
// object, the sequence of SpaceCell boxes it passes through (TEME frame) over a
// time window, split at bucket boundaries so each row sits in exactly one bucket.
//
//   npx tsx packages/backend/scripts/starmap/build-index.ts \
//     [--order 4] [--step 30] [--hours 3] [--bucket 30] [--start ISO] \
//     [--limit N] [--regime LEO] [--out file.csv] [--workers N]
//
// CSV columns: bucket,cell,ord,norad_id,t_in,t_out,elset_epoch
// (ISO-8601 UTC timestamps; cell = aligned int8 key as a decimal string).
// Per-object work lives in runs.ts (shared with measure.ts); workers return
// numeric rows and the aligned BigInt is only made when writing CSV.
// ============================================================

import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { alignedKey } from '@orbitwatch/orbital-core';
import { buildRuns, splitAtBuckets, makeProp, windowInCap, newStats } from './runs.js';
import { loadCatalog, parseArgs } from './catalog.js';

const CHUNK = 150;
const COLS = 5; // bucket, cell, tIn, tOut, objIndex

interface Job { base: number; omms: Array<Record<string, unknown>>; order: number; startMs: number; endMs: number; stepMs: number; bucketMs: number }
interface Done {
  base: number; rows: Float64Array; skips: Array<[number, string]>;
  propCalls: number; noCell: number; epochs: Array<[number, number]>;
}

// ---------------- worker ----------------
if (!isMainThread) {
  parentPort!.on('message', (j: Job) => {
    const st = newStats();
    const rows: number[] = [];
    const skips: Array<[number, string]> = [];
    const epochs: Array<[number, number]> = [];
    j.omms.forEach((omm, i) => {
      const idx = j.base + i;
      const p = makeProp(omm);
      if (!p) { skips.push([idx, 'bad-elements']); return; }
      if (!windowInCap(p, j.startMs, j.endMs)) { skips.push([idx, 'outside-60d-epoch-cap']); return; }
      epochs.push([idx, p.epochMs]);
      const runs = splitAtBuckets(buildRuns(p, j.order, j.startMs, j.endMs, j.stepMs, st), j.bucketMs);
      if (runs.length === 0) { skips.push([idx, 'no-valid-position']); return; }
      for (const r of runs) rows.push(r.bucket, r.cell, r.tIn, r.tOut, idx);
    });
    const arr = Float64Array.from(rows);
    const msg: Done = { base: j.base, rows: arr, skips, propCalls: st.propCalls, noCell: st.noCell, epochs };
    parentPort!.postMessage(msg, [arr.buffer]);
  });
}

// ---------------- main ----------------
async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const order = Number(a.get('order') ?? 4);
  const stepMs = Number(a.get('step') ?? 30) * 1000;
  const hours = Number(a.get('hours') ?? 3);
  const bucketMs = Number(a.get('bucket') ?? 30) * 60_000;
  const startMs = a.has('start') ? Date.parse(a.get('start')!) : Math.floor(Date.now() / bucketMs) * bucketMs;
  const endMs = startMs + hours * 3_600_000;
  const nWorkers = Number(a.get('workers') ?? availableParallelism());
  const outPath = a.get('out');
  const t0 = Date.now();

  const full = loadCatalog();
  let cat = full;
  if (a.has('regime')) cat = cat.filter((o) => o.regime === a.get('regime'));
  if (a.has('limit')) cat = cat.slice(0, Number(a.get('limit')));
  const objectsIn = cat.length;

  let out: WriteStream | null = null;
  if (outPath) {
    out = createWriteStream(outPath);
    out.write('bucket,cell,ord,norad_id,t_in,t_out,elset_epoch\n');
  }

  const epochOf = new Float64Array(cat.length);
  const rowsByRegime = new Map<string, number>();
  const objsByRegime = new Map<string, number>();
  const skipReasons = new Map<string, number>();
  const rowsPerObj = new Uint32Array(cat.length);
  let rows = 0, propCalls = 0, noCell = 0;
  const iso = (ms: number) => new Date(ms).toISOString();
  const alignCache = new Map<number, string>();

  const workerUrl = new URL(import.meta.url);
  const workers = Array.from({ length: nWorkers }, () => new Worker(fileURLToPath(new URL('./worker-boot.mjs', workerUrl))));
  let next = 0;
  const feed = (w: Worker): boolean => {
    if (next >= cat.length) return false;
    const base = next;
    next = Math.min(cat.length, next + CHUNK);
    const job: Job = { base, omms: cat.slice(base, next).map((o) => o.omm), order, startMs, endMs, stepMs, bucketMs };
    w.postMessage(job);
    return true;
  };

  await new Promise<void>((resolve, reject) => {
    let active = 0;
    for (const w of workers) {
      w.on('error', reject);
      w.on('message', async (d: Done) => {
        propCalls += d.propCalls;
        noCell += d.noCell;
        for (const [i, e] of d.epochs) epochOf[i] = e;
        for (const [, reason] of d.skips) skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
        const n = d.rows.length / COLS;
        rows += n;
        let buf = '';
        for (let r = 0; r < n; r++) {
          const o = r * COLS;
          const idx = d.rows[o + 4]!;
          const obj = cat[idx]!;
          rowsPerObj[idx]!++;
          rowsByRegime.set(obj.regime, (rowsByRegime.get(obj.regime) ?? 0) + 1);
          if (out) {
            const cell = d.rows[o + 1]!;
            let key = alignCache.get(cell);
            if (key === undefined) { key = alignedKey(order, cell).toString(); alignCache.set(cell, key); }
            buf += `${iso(d.rows[o]!)},${key},${order},${obj.noradId},${iso(d.rows[o + 2]!)},${iso(d.rows[o + 3]!)},${iso(epochOf[idx]!)}\n`;
          }
        }
        if (out && buf) { if (!out.write(buf)) await once(out, 'drain'); }
        if (!feed(w)) { if (--active === 0) resolve(); }
      });
      if (feed(w)) active++;
    }
    if (active === 0) resolve();
  });
  await Promise.all(workers.map((w) => w.terminate()));
  if (out) { out.end(); await once(out, 'finish'); }

  const wall = (Date.now() - t0) / 1000;
  for (const o of cat) objsByRegime.set(o.regime, (objsByRegime.get(o.regime) ?? 0) + 1);
  const skipped = [...skipReasons.values()].reduce((s, v) => s + v, 0);
  const indexed = objectsIn - skipped;
  const idxdByRegime = new Map<string, number>();
  for (let i = 0; i < cat.length; i++) if (rowsPerObj[i]! > 0) idxdByRegime.set(cat[i]!.regime, (idxdByRegime.get(cat[i]!.regime) ?? 0) + 1);

  console.log(`window ${iso(startMs)} .. ${iso(endMs)}  order=${order} step=${stepMs / 1000}s bucket=${bucketMs / 60000}min workers=${nWorkers}`);
  console.log(`objects in: ${objectsIn}  indexed: ${indexed}  skipped: ${skipped} ${JSON.stringify(Object.fromEntries(skipReasons))}`);
  console.log(`rows: ${rows}  propagation calls: ${propCalls} (no-cell evaluations: ${noCell})`);
  console.log('rows per object per hour by regime:');
  for (const [reg, n] of [...rowsByRegime].sort()) {
    console.log(`  ${reg.padEnd(6)} ${(n / (idxdByRegime.get(reg) ?? 1) / hours).toFixed(2)}  (${idxdByRegime.get(reg)} objects, ${n} rows)`);
  }
  const top = [...rowsPerObj.keys()].sort((x, y) => rowsPerObj[y]! - rowsPerObj[x]!).slice(0, 3);
  console.log('top row-count objects: ' + top.map((i) => `${cat[i]!.noradId} ${cat[i]!.name} [${cat[i]!.regime}] ${rowsPerObj[i]}`).join('; '));
  const fullByRegime = new Map<string, number>();
  for (const o of full) fullByRegime.set(o.regime, (fullByRegime.get(o.regime) ?? 0) + 1);
  let perDay = 0;
  for (const [reg, n] of rowsByRegime) perDay += (n / (idxdByRegime.get(reg) ?? 1) / hours) * 24 * (fullByRegime.get(reg) ?? 0);
  console.log(`rows/day extrapolated to the full ${full.length}-object catalog (per-regime rate x regime size): ${Math.round(perDay).toLocaleString()}`);
  console.log(`wall: ${wall.toFixed(1)}s  peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB (main thread process)`);
}

if (isMainThread) await main();
