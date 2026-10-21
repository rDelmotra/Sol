// ============================================================
// SPIKE — not production.
// Question B: all-vs-all close approaches < 10 km during 01:00-02:00Z on 2026-10-20 (conjunction screen).
//   (a) grid:   spatial hash rebuilt every step (cell >= 10 + VMAX*dt/2 + 1), 27-cell neighbour search, refine candidates
//   (c) hybrid: the same grid, but only pairs whose padded perigee/apogee intervals overlap are compared
//   (b) sieves: Sieve 0 sort-and-sweep on padded perigee/apogee intervals -> Sieve 1 MOID -> time filter -> refine
// Reference truth = (a) at dt = 5 s. All pipelines share the same candidate rule and the same refine
// (1 s scan + golden section to ms), so they differ only in HOW candidate pairs are enumerated.
//
//   npx tsx packages/backend/scripts/starmap/screen-all.ts [--pads max|p99] [--sample-every K] [--skip-grid10]
// ============================================================
import { parseArgs } from './catalog.js';
import { loadCtx, Pool, secs, candD, DT_MS, VMAX_KMS, type Ctx, type PadMode } from './screen-lib.js';
import { moidPrepared, COARSE_N } from './moid.js';
import type { GridOut, SieveOut, RefineOut, Task } from './screen-types.js';

const a = parseArgs(process.argv.slice(2));
const PADS = (a.get('pads') ?? 'max') as PadMode;
const THR = 10;
const ctx = loadCtx(PADS);
const pool = new Pool();
await pool.start(ctx);
const N = ctx.n, NS = ctx.nSteps;

// ---- propagate everything once into shared memory (dt = 5 s) ----
let t = Date.now();
await pool.map<number>(Array.from({ length: Math.ceil(N / 250) }, (_, k) => ({ type: 'fill' as const, o0: k * 250, o1: Math.min(N, (k + 1) * 250) })));
const fillSecs = secs(t);
console.log(`propagated ${N} objects x ${NS} steps (dt ${DT_MS / 1000} s) into shared memory: ${fillSecs.toFixed(1)} s wall on ${pool.size} workers (shared by all pipelines)`);

const pairKey = (i: number, j: number) => i * N + j;
const sameSet = (i: number, j: number) => ctx.group[i]! >= 0 && ctx.group[i] === ctx.group[j];

function mergeTriples(outs: Array<{ trip: Int32Array }>): { map: Map<number, number[]>; identicalDropped: number; triples: number } {
  const map = new Map<number, number[]>();
  let identical = 0, triples = 0;
  const idSeen = new Set<number>();
  for (const o of outs) for (let k = 0; k < o.trip.length; k += 3) {
    triples++;
    const i = o.trip[k]!, j = o.trip[k + 1]!, s = o.trip[k + 2]!;
    if (sameSet(i, j)) { idSeen.add(pairKey(i, j)); identical++; continue; }
    const key = pairKey(i, j);
    const l = map.get(key);
    if (l) l.push(s); else map.set(key, [s]);
  }
  return { map, identicalDropped: idSeen.size, triples };
}

async function refineAll(map: Map<number, number[]>, stride: number): Promise<{ found: Map<number, [number, number]>; secsWall: number; cpuMs: number }> {
  const t0 = Date.now();
  const entries = [...map];
  const tasks: Task[] = [];
  const CH = 1500;
  for (let c = 0; c < entries.length; c += CH) {
    const part = entries.slice(c, c + CH);
    let len = 0;
    for (const [, st] of part) len += 3 + new Set(st).size;
    const buf = new Int32Array(len);
    let p = 0;
    for (const [key, st] of part) {
      const u = [...new Set(st)].sort((x, y) => x - y);
      buf[p++] = Math.floor(key / N); buf[p++] = key % N; buf[p++] = u.length;
      for (const s of u) buf[p++] = s;
    }
    tasks.push({ type: 'refine', buf, stride, thr: THR });
  }
  const outs = await pool.map<RefineOut>(tasks);
  const found = new Map<number, [number, number]>();
  let cpu = 0;
  for (const o of outs) {
    cpu += o.ms;
    for (let k = 0; k < o.res.length; k += 4) if (o.res[k + 2]! < THR) found.set(pairKey(o.res[k]!, o.res[k + 1]!), [o.res[k + 2]!, o.res[k + 3]!]);
  }
  return { found, secsWall: secs(t0), cpuMs: cpu };
}

interface Row {
  name: string; cand: number; tests: number | string; found: Map<number, [number, number]>; stages: string;
}
const rows: Row[] = [];
const gridTasks = (stride: number, hybrid: boolean): Task[] => {
  const D = candD(stride), tasks: Task[] = [];
  const per = stride * Math.max(1, Math.floor(8 / stride));
  for (let s0 = 0; s0 < NS; s0 += per) tasks.push({ type: 'grid', s0, s1: Math.min(NS, s0 + per), stride, L: D, D, hybrid, gap: THR });
  return tasks;
};

async function runGrid(name: string, stride: number, hybrid: boolean): Promise<Row> {
  const t0 = Date.now();
  const outs = await pool.map<GridOut>(gridTasks(stride, hybrid));
  const gridWall = secs(t0);
  const m = mergeTriples(outs);
  const r = await refineAll(m.map, stride);
  const tests = outs.reduce((s, o) => s + o.tests, 0), skipped = outs.reduce((s, o) => s + o.skipped, 0);
  const cpu = outs.reduce((s, o) => s + o.ms, 0) / 1000;
  const row: Row = {
    name, cand: m.map.size, tests: tests + (hybrid ? ` (+${skipped} interval skips)` : ''), found: r.found,
    stages: `grid ${gridWall.toFixed(1)} s wall (${cpu.toFixed(0)} cpu-s) | refine ${r.secsWall.toFixed(1)} s | total ${(gridWall + r.secsWall).toFixed(1)} s | cell ${candD(stride).toFixed(0)} km | identical pairs dropped ${m.identicalDropped}`,
  };
  rows.push(row);
  return row;
}

const ref = await runGrid('(a) grid dt=5 s [REFERENCE]', 1, false);
await runGrid('(c) hybrid grid+Sieve0 dt=5 s', 1, true);
if (!a.has('skip-grid10')) await runGrid('(a) grid dt=10 s', 2, false);

// ---- diagnostics: does every reference pair pass the sieves' own tests? (cheap: only the reference pairs) ----
{
  let fail0 = 0, fail1 = 0;
  let minMargin0 = Infinity, minMargin1 = Infinity;
  const m1: number[] = [];
  for (const k of ref.found.keys()) {
    const i = Math.floor(k / N), j = k % N;
    const g0 = Math.max(ctx.lo[i]! - ctx.hi[j]!, ctx.lo[j]! - ctx.hi[i]!);
    const mo = moidPrepared(ctx.wires.subarray(i * 9, i * 9 + 9), ctx.samples.subarray(i * COARSE_N * 3, (i + 1) * COARSE_N * 3), ctx.wires.subarray(j * 9, j * 9 + 9), ctx.samples.subarray(j * COARSE_N * 3, (j + 1) * COARSE_N * 3)).dist;
    const lim1 = THR + ctx.pad1[i]! + ctx.pad1[j]!;
    minMargin0 = Math.min(minMargin0, THR - g0); minMargin1 = Math.min(minMargin1, lim1 - mo);
    m1.push(mo);
    const bad0 = g0 > THR, bad1 = mo > lim1;
    if (bad0) fail0++;
    if (bad1) fail1++;
    if (bad0 || bad1) {
      const d = ref.found.get(k)![0];
      console.log(`  DIAG fail: ${ctx.objs[i]!.noradId} ${ctx.objs[i]!.name} [${ctx.objs[i]!.regime}] vs ${ctx.objs[j]!.noradId} ${ctx.objs[j]!.name} [${ctx.objs[j]!.regime}] closest ${d.toFixed(2)} km; interval gap ${g0.toFixed(1)} (limit ${THR}); MOID ${mo.toFixed(1)} (limit ${lim1.toFixed(1)}; pad1 ${ctx.pad1[i]!.toFixed(1)}+${ctx.pad1[j]!.toFixed(1)}); lo/hi i ${ctx.lo[i]!.toFixed(0)}/${ctx.hi[i]!.toFixed(0)} j ${ctx.lo[j]!.toFixed(0)}/${ctx.hi[j]!.toFixed(0)}`);
    }
  }
  m1.sort((x, y) => x - y);
  console.log(`DIAG reference pairs failing Sieve 0: ${fail0}, Sieve 1: ${fail1} (smallest slack: S0 ${minMargin0.toFixed(1)} km, S1 ${minMargin1.toFixed(1)} km); MOID of true pairs p50 ${m1[Math.floor(m1.length / 2)]!.toFixed(1)} km, max ${m1.at(-1)!.toFixed(1)} km`);
  if (a.has('diagnose-only')) { await pool.close(); process.exit(0); }
}

// ---- (b) sieves ----
// Sieve 0: count with binary search (pure sort-and-sweep, no pair enumeration)
t = Date.now();
let n0 = 0;
for (let u = 0; u < N; u++) {
  const lim = ctx.hiS[u]! + THR;
  let lo = u + 1, hi = N;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ctx.loS[mid]! <= lim) lo = mid + 1; else hi = mid; }
  n0 += lo - u - 1;
}
const sieve0Secs = secs(t);
const allPairs = (N * (N - 1)) / 2;
console.log(`\nSieve 0 (padded perigee/apogee overlap, gap<=${THR} km, pads=${PADS}): ${n0} of ${allPairs} pairs survive (${(100 * n0 / allPairs).toFixed(2)}%), count in ${sieve0Secs.toFixed(2)} s`);
const estMoidWall = (n0 * 30e-6) / pool.size;
const sampleEvery = a.has('sample-every') ? Number(a.get('sample-every')) : estMoidWall > 600 ? Math.ceil(estMoidWall / 60) : 1;
console.log(`estimated full MOID wall ~${estMoidWall.toFixed(0)} s on ${pool.size} workers; sampling 1/${sampleEvery} of Sieve-0 survivors`);

const D1 = candD(1);
t = Date.now();
const U = 48, sTasks: Task[] = [];
for (let u0 = 0; u0 < N; u0 += U) sTasks.push({ type: 'sieve', u0, u1: Math.min(N, u0 + U), gap: THR, moid: true, scan: true, D: D1, sampleEvery, earlyExit: !a.has('exact-moid') });
const sOuts = await pool.map<SieveOut>(sTasks);
const sWall = secs(t);
const n1 = sOuts.reduce((s, o) => s + o.n1, 0), nS = sOuts.reduce((s, o) => s + o.n0, 0);
const cpuEnum = sOuts.reduce((s, o) => s + o.msEnum, 0) / 1000, cpuMoid = sOuts.reduce((s, o) => s + o.msMoid, 0) / 1000, cpuScan = sOuts.reduce((s, o) => s + o.msScan, 0) / 1000;
const sm = mergeTriples(sOuts);
const sr = await refineAll(sm.map, 1);
const inSample = (i: number, j: number) => sampleEvery <= 1 || ((Math.imul(Math.min(i, j), 2654435761) ^ Math.imul(Math.max(i, j), 40503)) >>> 0) % sampleEvery === 0;
console.log(`Sieve 1 (MOID <= ${THR} + pads): ${n1} survivors of ${sampleEvery > 1 ? `${nS} sampled` : nS} Sieve-0 pairs = ${(100 * n1 / Math.max(1, sampleEvery > 1 ? Math.round(n0 / sampleEvery) : nS)).toFixed(1)}% (of sampled)`);
// Note: with sampling, sOuts.n0 counts ALL Sieve-0 pairs enumerated (before the sample rule); n1 is over the sampled ones.
const moidBase = sampleEvery > 1 ? n0 / sampleEvery : nS;
rows.push({
  name: `(b) sieves 0+1+time filter dt=5 s${sampleEvery > 1 ? ` [MOID on 1/${sampleEvery} sample]` : ''}`,
  cand: sm.map.size, tests: `${nS} S0 pairs, MOID on ${Math.round(moidBase)}, scan on ${n1}`, found: sr.found,
  stages: `S0 count ${sieve0Secs.toFixed(2)} s | enumerate+MOID+scan wall ${sWall.toFixed(1)} s (cpu-s: enum ${cpuEnum.toFixed(0)}, MOID ${cpuMoid.toFixed(0)}, scan ${cpuScan.toFixed(0)}) | refine ${sr.secsWall.toFixed(1)} s | total ${(sieve0Secs + sWall + sr.secsWall).toFixed(1)} s | MOID ${((cpuMoid * 1e6) / Math.max(1, moidBase)).toFixed(1)} us/pair`,
});

// ---- agreement with the reference ----
console.log(`\nReference: ${ref.found.size} pairs closer than ${THR} km (identical-element-set pairs excluded); candidate pairs refined ${ref.cand}`);
console.log('pipeline | candidates refined | distance tests / work | found <10 km | missed vs ref | extra vs ref | stages');
for (const r of rows) {
  let missed = 0, extra = 0, scope = 0;
  for (const k of ref.found.keys()) {
    const i = Math.floor(k / N), j = k % N;
    if (!inSample(i, j) && r.name.includes('sieves')) continue;
    scope++;
    if (!r.found.has(k)) missed++;
  }
  for (const k of r.found.keys()) if (!ref.found.has(k)) extra++;
  console.log(`${r.name} | ${r.cand} | ${r.tests} | ${r.found.size} | ${missed}/${scope}${r.name.includes('sieves') && sampleEvery > 1 ? ' (in sample)' : ''} | ${extra} | ${r.stages}`);
}
// closest approaches summary
const ds = [...ref.found.values()].map((v) => v[0]).sort((x, y) => x - y);
console.log(`reference pairs: min ${ds[0]?.toFixed(3)} km, median ${ds[Math.floor(ds.length / 2)]?.toFixed(2)} km`);
console.log(`candidate rule: d <= ${THR} + ${VMAX_KMS} km/s x dt/2 + 1 km`);
await pool.close();
