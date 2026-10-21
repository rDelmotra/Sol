// ============================================================
// SPIKE — not production.
// Question C: "who is in order-2 box X during 02:00-02:10?" How much does Sieve 0 (the box's radial
// range vs each object's padded perigee/apogee interval) cut the set that has to be propagated to build
// the in-memory runs, and does it lose anyone? Truth = cached 1 s brute force (queries.ts Q1).
//
//   npx tsx packages/backend/scripts/starmap/screen-box.ts [--box 4160] [--order 2] [--step 20]
// ============================================================
import { readFileSync } from 'node:fs';
import { existsSync, writeFileSync } from 'node:fs';
import { decodeKey, cellKey, SHELL_DELTA0, WGS84_A_KM } from '@orbitwatch/orbital-core';
import { parseArgs } from './catalog.js';
import { loadCtx, sgp4Pos, type PadMode } from './screen-lib.js';
import { buildRuns, newStats } from './runs.js';

const a = parseArgs(process.argv.slice(2));
const ORDER = Number(a.get('order') ?? 2), STEP = Number(a.get('step') ?? 20) * 1000;
const wS = Date.parse('2026-10-20T02:00:00Z'), wE = Date.parse('2026-10-20T02:10:00Z');
// --like NORAD: use the order-2 box that object sits in at 02:05 (truth computed by 1 s brute force and cached)
const probe = a.has('like') ? loadCtx('max', { windowOnly: true }) : null;
let BOX = Number(a.get('box') ?? 4160);
if (probe) {
  const o = probe.objs.findIndex((x) => x.noradId === Number(a.get('like')));
  const p = sgp4Pos(probe.props[o]!, (wS + wE) / 2)!;
  BOX = cellKey(ORDER, p[0], p[1], p[2])!;
}
const truthFile = `/tmp/starmap/truth-q1-2026-10-20-${BOX}.json`;
if (!existsSync(truthFile)) {
  const ctx = probe ?? loadCtx('max', { windowOnly: true });
  const hit = new Set<number>();
  const t = Date.now();
  ctx.props.forEach((p, i) => { for (let tm = wS; tm <= wE; tm += 1000) { const x = sgp4Pos(p, tm); if (x && cellKey(ORDER, x[0], x[1], x[2]) === BOX) { hit.add(ctx.objs[i]!.noradId); break; } } });
  writeFileSync(truthFile, JSON.stringify({ v: [...hit], secs: (Date.now() - t) / 1000 }));
}
const truth = new Set((JSON.parse(readFileSync(truthFile, 'utf8')) as { v: number[] }).v);

const { nk } = decodeKey(ORDER, BOX);
const rLo = WGS84_A_KM * Math.exp((nk * SHELL_DELTA0) / 2 ** ORDER), rHi = WGS84_A_KM * Math.exp(((nk + 1) * SHELL_DELTA0) / 2 ** ORDER);
console.log(`box ${BOX} order ${ORDER}: radial shell ${rLo.toFixed(0)}..${rHi.toFixed(0)} km (${(rHi - rLo).toFixed(0)} km thick), window ${new Date(wS).toISOString()}..${new Date(wE).toISOString()}, truth ${truth.size} objects`);

function build(idx: number[], ctxObjs: { norad: number }[], props: Parameters<typeof buildRuns>[0][]): { found: Set<number>; ms: number; calls: number } {
  const st = newStats();
  const t = performance.now();
  const found = new Set<number>();
  for (const i of idx) {
    if (buildRuns(props[i]!, ORDER, wS, wE, STEP, st).some((r) => r.cell === BOX)) found.add(ctxObjs[i]!.norad);
  }
  return { found, ms: performance.now() - t, calls: st.propCalls };
}

for (const mode of ['max', 'p99'] as PadMode[]) {
  const ctx = loadCtx(mode, { windowOnly: true });
  const objs = ctx.objs.map((o) => ({ norad: o.noradId }));
  const all = Array.from({ length: ctx.n }, (_, i) => i);
  const t0 = performance.now();
  const sieve = all.filter((i) => ctx.lo[i]! <= rHi && ctx.hi[i]! >= rLo);
  const sieveMs = performance.now() - t0;
  const full = build(all, objs, ctx.props);
  const cut = build(sieve, objs, ctx.props);
  const recall = (s: Set<number>) => { let k = 0; for (const n of truth) if (s.has(n)) k++; return `${k}/${truth.size} (${(100 * k / truth.size).toFixed(2)}%)`; };
  console.log(`\npads=${mode}`);
  console.log(`  no prefilter : ${all.length} objects propagated, ${full.calls} SGP4 calls, ${(full.ms / 1000).toFixed(2)} s, in-box ${full.found.size}, recall ${recall(full.found)}`);
  console.log(`  Sieve 0      : ${sieve.length} objects propagated (${(100 * sieve.length / all.length).toFixed(1)}%), ${cut.calls} SGP4 calls, sieve ${sieveMs.toFixed(1)} ms + build ${(cut.ms / 1000).toFixed(2)} s, in-box ${cut.found.size}, recall ${recall(cut.found)}`);
  const extra = [...cut.found].filter((n) => !truth.has(n)).length;
  console.log(`  extra vs 1 s truth (runs at ${STEP / 1000} s step + bisect): no-prefilter ${[...full.found].filter((n) => !truth.has(n)).length}, Sieve 0 ${extra}`);
}
