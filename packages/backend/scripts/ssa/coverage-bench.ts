// Benchmark and check of the ground-pass query against a brute-force sweep, on a LOCAL database with coverage files built for the days.
//   DATABASE_URL=postgres://... npx tsx scripts/ssa/coverage-bench.ts --days 2026-10-13,2026-10-14,2026-10-15 --region india [--brute] [--limit 200000]
//   --region india | japan | ... | circle:48.8566,2.3522,500
// Reports: query wall time (cold; objects only; with passes), candidates, and with --brute the recall / precision against a 10 s sweep of
// every object (the spike's truth) with each day's own element sets. Never point DATABASE_URL at a shared or production database.
import { cpus } from 'node:os';
import { getPool, closeHistory } from '../../src/history/db/pool.js';
import { WorkerPool } from '../../src/ssa/pool.js';
import { passesOver, passedOverSet, clearPassesCaches, circleRegion, resolveRegion, type Region } from '../../src/ssa/passes/index.js';
import { loadOmmCatalog } from '../../src/ssa/coverage/catalog.js';
import type { BruteTask, RefineOut } from '../../src/ssa/coverage/worker.js';

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const days = (arg('days') ?? '').split(',').filter(Boolean);
if (!days.length) throw new Error('--days is required');
const regionArg = arg('region') ?? 'india';
const region: Region = regionArg.startsWith('circle:') ? circleRegion(...(regionArg.slice(7).split(',').map(Number) as [number, number, number])) : resolveRegion(regionArg);
const DAY = 86_400_000;
const from = Date.parse(days[0] + 'T00:00:00Z'), to = Date.parse(days[days.length - 1] + 'T00:00:00Z') + DAY;
const workers = Number(arg('workers') ?? Math.min(4, cpus().length));
const pool = getPool();
if (!pool) throw new Error('DATABASE_URL is not set');
const secs = (t0: number) => ((performance.now() - t0) / 1000).toFixed(1);

console.log(`region ${region.id} (${region.name}), days ${days.join(', ')}, ${workers} workers`);
let t0 = performance.now();
const set = await passedOverSet(pool, region, from, to, { workers, nowMs: to + DAY });
console.log(`passedOverSet (cold, objects only): ${secs(t0)} s -> ${set.ids.size} objects; days ${set.stats.days}, candidate object-days ${set.stats.candidateObjectDays}, refined object-days ${set.stats.refinedObjectDays} (cover ${set.stats.coverS.toFixed(1)} s, catalog load ${set.stats.loadS.toFixed(1)} s, refine ${set.stats.refineS.toFixed(1)} s); missing ${JSON.stringify(set.missingDays)}`);
t0 = performance.now();
const again = await passesOver(pool, region, from, to, { workers, nowMs: to + DAY, limit: 0 });
console.log(`same query again (result cache): ${secs(t0)} s, ${again.totalObjects} objects`);
clearPassesCaches();
const limit = Number(arg('limit') ?? 50);
t0 = performance.now();
const full = await passesOver(pool, region, from, to, { workers, nowMs: to + DAY, limit });
console.log(`passesOver cold, limit ${limit}: ${secs(t0)} s -> ${full.totalObjects} objects, ${full.objects.length} listed with ${full.objects.reduce((s, o) => s + o.passes.length, 0)} passes (refined object-days ${full.stats.refinedObjectDays}, refine ${full.stats.refineS.toFixed(1)} s)`);

if (process.argv.includes('--brute')) {
  const ids = new Set<number>(), passes = new Map<number, Array<[number, number]>>();
  const wp = new WorkerPool(workers, 'coverage/worker');
  await wp.start({ kind: 'init' });
  let bruteS = 0;
  for (const day of days) {
    const cat = await loadOmmCatalog(pool, day);
    const startMs = Date.parse(day + 'T00:00:00Z');
    const tasks: BruteTask[] = [];
    for (let b = 0; b < cat.length; b += 200) { const sl = cat.slice(b, b + 200); tasks.push({ kind: 'brute', region, omms: sl.map((o) => o.omm), norad: sl.map((o) => o.noradId), startMs, endMs: startMs + DAY, stepMs: 10_000 }); }
    const t1 = performance.now();
    const res = await wp.map<RefineOut>(tasks);
    bruteS += (performance.now() - t1) / 1000;
    res.forEach((r, ti) => r.intervals.forEach((iv, k) => {
      const nd = cat[ti * 200 + k]!.noradId;
      if (!iv.length) return;
      ids.add(nd);
      const arr = passes.get(nd) ?? []; for (let i = 0; i < iv.length; i += 2) arr.push([iv[i]!, iv[i + 1]!]); passes.set(nd, arr);
    }));
  }
  await wp.close();
  console.log(`brute force (10 s, every object, ${days.length} days): ${bruteS.toFixed(1)} s -> ${ids.size} objects`);
  const got = new Set(set.ids);
  let hit = 0; for (const n of ids) if (got.has(n)) hit++;
  const extra = [...got].filter((n) => !ids.has(n));
  console.log(`objects: recall ${hit}/${ids.size} (${((100 * hit) / ids.size).toFixed(4)}%), query-only ${extra.length} (precision vs 10 s sweep ${((100 * hit) / got.size).toFixed(4)}%)  [query-only = visits shorter than the 10 s step, confirmed at 1 s: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ', ...' : ''}]`);
  const missed = [...ids].filter((n) => !got.has(n));
  if (missed.length) console.log(`MISSED objects: ${missed.join(', ')}`);
  // pass level, for the objects the query listed with passes (limit)
  if (limit > 0) {
    let bp = 0, found = 0, qp = 0, qMatched = 0;
    for (const o of full.objects) {
      // query pieces separated by <= 10 s count as one (the 10 s sweep cannot see a shorter gap), as the spike's T3 matching rule
      const qs: Array<[number, number]> = [];
      for (const r of o.passes) { const l = qs[qs.length - 1]; if (l && r[0] - l[1] <= 10_000) l[1] = Math.max(l[1], r[1]); else qs.push([r[0], r[1]]); }
      qp += qs.length;
      const bs = (passes.get(o.noradId) ?? []).sort((a, b) => a[0] - b[0]);
      // merge brute runs separated by <= 10 s (and across midnight)
      const mb: Array<[number, number]> = [];
      for (const r of bs) { const l = mb[mb.length - 1]; if (l && r[0] - l[1] <= 10_000) l[1] = Math.max(l[1], r[1]); else mb.push([r[0], r[1]]); }
      bp += mb.length;
      for (const b of mb) if (qs.some(([s, e]) => Math.abs(s - b[0]) <= 20_000 && Math.abs(e - b[1]) <= 20_000)) found++;
      for (const [s, e] of qs) if (mb.some((b) => Math.abs(s - b[0]) <= 20_000 && Math.abs(e - b[1]) <= 20_000)) qMatched++;
    }
    console.log(`passes (${full.objects.length} listed objects): brute passes ${bp}, found within 20 s at both ends ${found} (${bp ? ((100 * found) / bp).toFixed(3) : '-'}%); query passes ${qp}, matched ${qMatched} (${qp ? ((100 * qMatched) / qp).toFixed(3) : '-'}%)`);
  }
}
await closeHistory();
