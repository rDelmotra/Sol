// ============================================================
// SPIKE — not production.
//
// Accuracy/cost measurement for the star-fixed index. For a seeded,
// regime-stratified sample of objects it builds GROUND TRUTH cell visits by
// propagating every 1 s, then compares the stepped+bisected runs (the SAME
// buildRuns() build-index.ts uses) across orders x steps:
//   missed   = truth visits with no overlapping index run in the same cell
//   spurious = index runs with no overlapping truth visit in that cell
//   |tIn|/|tOut| error (s) for matched visits (window-clipped endpoints excluded)
//   propagation calls + CPU time per object, rows per object per hour by regime
//
//   npx tsx packages/backend/scripts/starmap/measure.ts \
//     [--hours 2] [--leo 300] [--meo 60] [--geo 60] [--heo 60] [--seed 1]
//     [--orders 3,4,5,6] [--steps 10,20,30,60] [--start ISO]
// ============================================================

import { buildRuns, makeProp, windowInCap, newStats, type Run, type Prop } from './runs.js';
import { loadCatalog, parseArgs, rng } from './catalog.js';

const a = parseArgs(process.argv.slice(2));
const hours = Number(a.get('hours') ?? 2);
const seed = Number(a.get('seed') ?? 1);
const orders = (a.get('orders') ?? '3,4,5,6').split(',').map(Number);
const steps = (a.get('steps') ?? '10,20,30,60').split(',').map(Number);
const bucketMs = 30 * 60_000;
const startMs = a.has('start') ? Date.parse(a.get('start')!) : Math.floor(Date.now() / bucketMs) * bucketMs;
const endMs = startMs + hours * 3_600_000;
const want: Record<string, number> = {
  LEO: Number(a.get('leo') ?? 300), MEO: Number(a.get('meo') ?? 60),
  GEO: Number(a.get('geo') ?? 60), HEO: Number(a.get('heo') ?? 60),
};

// ---- seeded stratified sample ----
const cat = loadCatalog();
const rand = rng(seed);
const sample: Array<{ regime: string; norad: number; p: Prop }> = [];
for (const reg of Object.keys(want)) {
  const pool = cat.filter((o) => o.regime === reg);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  let n = 0;
  for (const o of pool) {
    if (n >= want[reg]!) break;
    const p = makeProp(o.omm);
    if (p && windowInCap(p, startMs, endMs)) { sample.push({ regime: reg, norad: o.noradId, p }); n++; }
  }
}
console.log(`window ${new Date(startMs).toISOString()} .. ${new Date(endMs).toISOString()} (${hours} h), seed ${seed}`);
console.log(`sample: ${sample.length} objects (${Object.entries(want).map(([r, n]) => `${r} ${n}`).join(', ')})\n`);

// ---- matching ----
function compare(truth: Run[], idx: Run[]) {
  const byCell = (rs: Run[]) => {
    const m = new Map<number, Run[]>();
    for (const r of rs) { const l = m.get(r.cell); if (l) l.push(r); else m.set(r.cell, [r]); }
    return m;
  };
  const tc = byCell(truth), ic = byCell(idx);
  const missDur: number[] = [];
  let missed = 0, spurious = 0, matched = 0, sIn = 0, sOut = 0, mIn = 0, mOut = 0, nErr = 0;
  for (const t of truth) {
    let best: Run | null = null, bestOv = 0;
    for (const r of ic.get(t.cell) ?? []) {
      const ov = Math.min(t.tOut, r.tOut) - Math.max(t.tIn, r.tIn);
      if (ov > bestOv) { bestOv = ov; best = r; }
    }
    if (!best) { missed++; missDur.push((t.tOut - t.tIn) / 1000); continue; }
    matched++;
    if (t.tIn > startMs) { const e = Math.abs(t.tIn - best.tIn) / 1000; sIn += e; mIn = Math.max(mIn, e); }
    if (t.tOut < endMs) { const e = Math.abs(t.tOut - best.tOut) / 1000; sOut += e; mOut = Math.max(mOut, e); }
    nErr++;
  }
  for (const r of idx) {
    if (!(tc.get(r.cell) ?? []).some((t) => Math.min(t.tOut, r.tOut) - Math.max(t.tIn, r.tIn) > 0)) spurious++;
  }
  return { missDur, missed, spurious, matched, sIn, sOut, mIn, mOut, nErr };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
const best = new Map<number, number>(); // order -> largest step with 0 missed
const best05 = new Map<number, number>(); // order -> largest step with <=0.05% missed
console.log('ord step | truth | missed (%)    spur | |tIn| mean/max s | |tOut| mean/max s | calls/obj  ms/obj | missed dur s med/max | rows/obj/h  LEO  MEO  GEO  HEO');
for (const order of orders) {
  // ground truth once per order
  const truths = sample.map((s) => buildRuns(s.p, order, startMs, endMs, 1000, newStats()));
  const nTruth = truths.reduce((s, r) => s + r.length, 0);
  for (const step of steps) {
    let missed = 0, spurious = 0, sIn = 0, sOut = 0, mIn = 0, mOut = 0, nErr = 0;
    const st = newStats();
    const md: number[] = [];
    let cpuMs = 0;
    const rowsReg: Record<string, number> = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
    sample.forEach((s, i) => {
      const t0 = performance.now();
      const runs = buildRuns(s.p, order, startMs, endMs, step * 1000, st);
      cpuMs += performance.now() - t0;
      rowsReg[s.regime]! += runs.length;
      const c = compare(truths[i]!, runs);
      missed += c.missed; md.push(...c.missDur); spurious += c.spurious; sIn += c.sIn; sOut += c.sOut;
      mIn = Math.max(mIn, c.mIn); mOut = Math.max(mOut, c.mOut); nErr += c.nErr;
    });
    const rr = (r: string) => (rowsReg[r]! / want[r]! / hours).toFixed(1);
    console.log(
      `${pad(order, 3)} ${pad(step, 4)} | ${pad(nTruth, 5)} | ${pad(missed, 5)} (${((100 * missed) / nTruth).toFixed(2)}%) ${pad(spurious, 5)} | ` +
      `${(sIn / (nErr || 1)).toFixed(2)}/${mIn.toFixed(1)}`.padStart(16) + ' | ' +
      `${(sOut / (nErr || 1)).toFixed(2)}/${mOut.toFixed(1)}`.padStart(17) + ' | ' +
      `${pad(Math.round(st.propCalls / sample.length), 9)} ${pad((cpuMs / sample.length).toFixed(2), 7)} | ` +
      `${pad(md.length ? `${md.sort((x, y) => x - y)[md.length >> 1]!.toFixed(0)}/${md[md.length - 1]!.toFixed(0)}` : '-', 20)} ${pad(rr('LEO'), 5)} ${pad(rr('MEO'), 4)} ${pad(rr('GEO'), 4)} ${pad(rr('HEO'), 4)}`,
    );
    if (missed === 0) best.set(order, Math.max(best.get(order) ?? 0, step));
    if (missed / nTruth <= 0.0005) best05.set(order, Math.max(best05.get(order) ?? 0, step));
  }
}
console.log('\nrecommendation (cheapest = largest step with 0 missed visits):');
for (const order of orders) {
  const s = best.get(order);
  console.log(`  order ${order}: ${s ? `step ${s}s` : `none of ${steps.join('/')}s reaches 0 missed`}; <=0.05% missed: ${best05.get(order) ? `step ${best05.get(order)}s` : 'none'}`);
}
