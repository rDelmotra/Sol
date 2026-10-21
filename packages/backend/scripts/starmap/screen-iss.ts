// ============================================================
// SPIKE — not production.
// Question A: objects within R km of the ISS (25544) during 01:00-02:00Z on 2026-10-20.
//   (a) brute force: every object, SGP4 every 1 s (truth, cached in /tmp/starmap/)
//   (b) sieves: 0 apogee/perigee overlap -> 1 MOID (orbit-path filter) -> 2 SGP4 refine at 1 s on survivors
//
//   npx tsx packages/backend/scripts/starmap/screen-iss.ts [--radii 50,100,500] [--pads max,p99]
// ============================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from './catalog.js';
import { loadCtx, Pool, sgp4Pos, secs, WIN_START, WIN_END, type PadMode, type Ctx } from './screen-lib.js';
import { moidPrepared, COARSE_N } from './moid.js';

const a = parseArgs(process.argv.slice(2));
const RADII = (a.get('radii') ?? '50,100,500').split(',').map(Number);
const PADS = (a.get('pads') ?? 'max,p99').split(',') as PadMode[];
const ISS = Number(a.get('target') ?? 25544); // default: the ISS; --target N screens around another object (e.g. a GEO satellite)
const NS = (WIN_END - WIN_START) / 1000 + 1;
const CHUNK = 250;

const ctxs = PADS.map((m, k) => loadCtx(m, { windowOnly: k > 0 }));
const base = ctxs[0]!;
const issIdx = base.objs.findIndex((o) => o.noradId === ISS);
const pool = new Pool();
await pool.start(base);

const iss = new Float64Array(NS * 3);
for (let k = 0; k < NS; k++) iss.set(sgp4Pos(base.props[issIdx]!, WIN_START + k * 1000)!, k * 3);

const scan = async (idx: number[]): Promise<Map<number, number>> => {
  const tasks = [];
  for (let k = 0; k < idx.length; k += CHUNK) tasks.push({ type: 'issScan' as const, idx: Int32Array.from(idx.slice(k, k + CHUNK)), iss, nIss: NS, stepMs: 1000 });
  const outs = await pool.map<{ res: Float64Array }>(tasks);
  const m = new Map<number, number>();
  for (const o of outs) for (let k = 0; k < o.res.length; k += 3) m.set(o.res[k]!, o.res[k + 1]!);
  return m;
};

const VMAX = 20, COARSE_S = 30;
const coarse = async (idx: number[], R: number): Promise<{ m: Map<number, number>; evals: number }> => {
  const tasks = [];
  for (let k = 0; k < idx.length; k += CHUNK) tasks.push({ type: 'issCoarse' as const, idx: Int32Array.from(idx.slice(k, k + CHUNK)), iss, nIss: NS, coarseS: COARSE_S, R, vmax: VMAX });
  const outs = await pool.map<{ res: Float64Array; evals: number }>(tasks);
  const m = new Map<number, number>();
  let evals = 0;
  for (const o of outs) { evals += o.evals; for (let k = 0; k < o.res.length; k += 3) m.set(o.res[k]!, o.res[k + 1]!); }
  return { m, evals };
};

// ---- (a) brute force truth at 1 s ----
const TRUTH = ISS === 25544 ? '/tmp/starmap/truth-qA-1s-2026-10-20.json' : `/tmp/starmap/truth-qA-1s-${ISS}-2026-10-20.json`;
let truth: Map<number, number>;
let bruteSecs: number;
if (existsSync(TRUTH)) {
  const j = JSON.parse(readFileSync(TRUTH, 'utf8')) as { secs: number; v: Array<[number, number]> };
  const idxOf = new Map(base.objs.map((o, i) => [o.noradId, i] as [number, number]));
  truth = new Map(j.v.map(([n, d]) => [idxOf.get(n)!, d ?? Infinity] as [number, number]));
  bruteSecs = j.secs;
  console.log(`brute force 1 s: cached (${bruteSecs.toFixed(1)} s wall when computed, ${pool.size} workers)`);
} else {
  const t = Date.now();
  truth = await scan(Array.from({ length: base.n }, (_, i) => i));
  bruteSecs = secs(t);
  writeFileSync(TRUTH, JSON.stringify({ secs: bruteSecs, v: [...truth].map(([i, d]) => [base.objs[i]!.noradId, d]) }));
  console.log(`brute force 1 s: ${base.n} objects x ${NS} steps in ${bruteSecs.toFixed(1)} s wall (${pool.size} workers)`);
}

function sieves(ctx: Ctx, R: number): { s0: number[]; s1: number[]; t0: number; t1: number } {
  const ts = performance.now();
  const s0: number[] = [];
  for (let i = 0; i < ctx.n; i++) {
    if (i === issIdx) continue;
    if (ctx.lo[i]! - ctx.hi[issIdx]! <= R && ctx.lo[issIdx]! - ctx.hi[i]! <= R) s0.push(i);
  }
  const t0 = performance.now() - ts;
  const tm = performance.now();
  const s1: number[] = [];
  const wi = ctx.wires.subarray(issIdx * 9, issIdx * 9 + 9), si = ctx.samples.subarray(issIdx * COARSE_N * 3, (issIdx + 1) * COARSE_N * 3);
  for (const i of s0) {
    const m = moidPrepared(wi, si, ctx.wires.subarray(i * 9, i * 9 + 9), ctx.samples.subarray(i * COARSE_N * 3, (i + 1) * COARSE_N * 3)).dist;
    if (m <= R + ctx.pad1[i]! + ctx.pad1[issIdx]!) s1.push(i);
  }
  return { s0, s1, t0: t0 / 1000, t1: (performance.now() - tm) / 1000 };
}

console.log(`\nQuestion A: objects within R km of ISS, ${new Date(WIN_START).toISOString()}..${new Date(WIN_END).toISOString()}  (universe ${base.n}; brute force ${bruteSecs.toFixed(1)} s wall on ${pool.size} workers)`);
console.log('pads | R km | truth | sieve0 surv | sieve1 surv | caught | catch % | t0 s | t1(MOID) s | t2(SGP4 1 s) s | total s | vs brute');
for (const ctx of ctxs) {
  for (const R of RADII) {
    const tr = [...truth].filter(([i, d]) => i !== issIdx && d < R).map(([i]) => i);
    const t = Date.now();
    const sv = sieves(ctx, R);
    const t2s = Date.now();
    const refined = await scan(sv.s1);
    const t2 = secs(t2s);
    const total = secs(t);
    const found = new Set([...refined].filter(([, d]) => d < R).map(([i]) => i));
    const caught = tr.filter((i) => found.has(i));
    const missed = tr.filter((i) => !found.has(i));
    console.log(`${ctx.padMode} | ${R} | ${tr.length} | ${sv.s0.length} (${(100 * sv.s0.length / ctx.n).toFixed(1)}%) | ${sv.s1.length} (${(100 * sv.s1.length / ctx.n).toFixed(1)}%) | ${caught.length} | ${tr.length ? (100 * caught.length / tr.length).toFixed(2) : '-'} | ${sv.t0.toFixed(3)} | ${sv.t1.toFixed(2)} | ${t2.toFixed(1)} | ${total.toFixed(1)} | ${(bruteSecs / total).toFixed(1)}x`);
    if (missed.length) console.log(`   MISSED: ${missed.slice(0, 12).map((i) => `${ctx.objs[i]!.noradId}(${truth.get(i)!.toFixed(1)}km)`).join(', ')}`);
  }
}
// ---- time filter alone / after sieves: SGP4 every 30 s with relative-motion pad, 1 s only near hits ----
console.log(`\nTime filter (SGP4 every ${COARSE_S} s, pad ${VMAX} km/s x ${COARSE_S / 2} s, then 1 s around hits) with and without the sieves, pads=max:`);
console.log('R km | variant | objects scanned | SGP4 evals | caught/truth | wall s');
for (const R of RADII) {
  const tr = [...truth].filter(([i, d]) => i !== issIdx && d < R).map(([i]) => i);
  const all = Array.from({ length: base.n }, (_, i) => i).filter((i) => i !== issIdx);
  let t = Date.now();
  const r1 = await coarse(all, R);
  const w1 = secs(t);
  console.log(`${R} | time filter only (no sieves) | ${all.length} | ${r1.evals} | ${tr.filter((i) => (r1.m.get(i) ?? Infinity) < R).length}/${tr.length} | ${w1.toFixed(1)}`);
  t = Date.now();
  const sv = sieves(base, R);
  const r2 = await coarse(sv.s1, R);
  const w2 = secs(t);
  console.log(`${R} | sieve0 + sieve1 + time filter | ${sv.s1.length} | ${r2.evals} | ${tr.filter((i) => (r2.m.get(i) ?? Infinity) < R).length}/${tr.length} | ${w2.toFixed(1)}`);
}
const zero = [...truth].filter(([i, d]) => i !== issIdx && d < 0.001).length;
console.log(`objects at ~0 km from the ISS all hour (shared element set): ${zero}`);
await pool.close();
