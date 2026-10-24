// ============================================================
// SPIKE — not production. S5: 36 h forward conjunction screener with collision probability.
//   export STARMAP_DB=postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch      (only used to read recent manoeuvre flags)
//   npx tsx packages/backend/scripts/starmap/screen-forward.ts --from 2026-10-12 --to 2026-10-18 [--hours 36] [--dt 5] [--workers 3]
//   npx tsx packages/backend/scripts/starmap/screen-forward.ts --day 2026-10-15 --hours 3 --tag slice3h     (a short slice for verification)
//
// One BATCH = the element sets a service would hold at DAY 12:00 UTC (latest set per object, see causalCatalog) screened for the next
// --hours (default 36). Each batch runs in its own process (so peak RSS is per batch), writes
//   data/forward/batch-DAY[-TAG].jsonl.gz   one event per line (pair, TCA, miss, relative speed, RIC miss, epochs, ages, category, Pc x4, ...)
//   data/forward/batch-DAY[-TAG].meta.json  timings, counts, SGP4 calls, peak RSS, Pc distribution (written last = the batch is done)
// and is skipped if its meta file exists (resumable; --force to redo). forward-report.ts matches events across batches and loads the DB.
//
// Reused from T2 (derive-day.ts): the per-step spatial hash grid (cube cells of L km, half-neighbourhood, linear closest-approach test,
// events-worker.ts `ca`), the exact refine (0.25 s scan + golden section, `refine`), the formation exclusion (pairs within 50 km for more than
// half of the window, `formFrac`), the identical-element-set exclusion and the garbage-orbit fence. New here: the causal catalog, covariance and Pc.
// ============================================================
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { parseArgs } from './catalog.js';
import { makeProp, type Prop } from './runs.js';
import { EvPool } from './events-pool.js';
import { identicalGroups, posAt, DB_URL, epochMsOf, type CatFull } from './events.js';
import type { CaOut } from './events-worker.js';
import { classifyCa, type ElsetLite } from './events-ca.js';
import { batchTimeMs, causalCatalog, evaluateEvent, quantile, type FwdEvent } from './forward-lib.js';

export const FORWARD_DIR = fileURLToPath(new URL('../../data/forward/', import.meta.url));
export const batchFile = (day: string, tag = '', ext = 'jsonl.gz') => `${FORWARD_DIR}batch-${day}${tag ? '-' + tag : ''}.${ext}`;
export const FENCED_IDS = new Set([54922]);
export const CA_KM = 5;
export const FORM_KM = 50;
export const FORM_FRAC = 0.5;
const secs = (t: number) => +((Date.now() - t) / 1000).toFixed(2);

async function recentJumps(t0: number): Promise<{ set: Set<number>; ok: boolean }> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 4000 });
  try {
    await c.connect();
    const r = await c.query("SELECT DISTINCT subjects[1] AS id FROM starmap.event WHERE kind = 'elements.jump' AND t_end <= to_timestamp($1 / 1000.0) AND t_end > to_timestamp($2 / 1000.0)", [t0, t0 - 7 * 86_400_000]);
    return { set: new Set((r.rows as Array<{ id: number }>).map((x) => x.id)), ok: true };
  } catch { return { set: new Set(), ok: false }; } finally { await c.end().catch(() => undefined); }
}

async function runBatch(day: string, hours: number, dtS: number, workers: number, tag: string): Promise<void> {
  const T = Date.now();
  mkdirSync(FORWARD_DIR, { recursive: true });
  const t0 = batchTimeMs(day), nSteps = Math.round((hours * 3600) / dtS), t1 = t0 + nSteps * dtS * 1000, dtMs = dtS * 1000;
  const timing: Record<string, number> = {};
  let tm = Date.now();

  // ---- catalog as of the batch time, usable objects only ----
  const cc = causalCatalog(day);
  const objs: CatFull[] = [];
  let fenced = 0, unusable = 0, garbage = 0;
  const props: Prop[] = [];
  for (const o of cc.objs) {
    if (FENCED_IDS.has(o.noradId)) { fenced++; continue; }
    const p = makeProp(o.omm);
    if (!p) { unusable++; continue; }
    let bad = false;
    for (const t of [t0, (t0 + t1) / 2, t1]) { const r = posAt(p, t); if (!r) { bad = true; break; } const rad = Math.hypot(r[0], r[1], r[2]); if (rad < 6340 || rad > 1e6) { bad = true; break; } }
    if (bad) { garbage++; continue; }
    objs.push(o); props.push(p);
  }
  const N = objs.length;
  const { group, groups } = identicalGroups(objs);
  const jumps = await recentJumps(t0);
  timing.load = secs(tm);

  tm = Date.now();
  const pool = new EvPool(workers);
  await pool.start({ type: 'init', omm: objs.map((o) => o.omm), group });
  timing.poolInit = secs(tm);

  // ---- grid: every dt seconds, hash cells of L km, neighbour cells, linear closest-approach test (events-worker.ts `ca`) ----
  tm = Date.now();
  const slack = 0.5;
  const L = CA_KM + 2 + 20 * (dtS / 2 + slack) + 1; // 68 km at 5 s: the most two bound objects (20 km/s relative) can close in half a step, plus margin
  const formEvery = Math.round(1800 / dtS), SL = Math.round(600 / dtS);
  const tasks = [];
  for (let s = 0; s <= nSteps; s += SL) tasks.push({ type: 'ca', s0: s, s1: Math.min(nSteps + 1, s + SL), t0Ms: t0, dtMs, L, thr: CA_KM, slack, formEvery, formKm: FORM_KM });
  const outs = await pool.map<CaOut>(tasks);
  timing.grid = secs(tm);
  const gridCpu = outs.reduce((s, o) => s + o.ms, 0) / 1000;
  const pairTests = outs.reduce((s, o) => s + o.tests, 0);

  // ---- formation exclusion: within 50 km at a half-hourly sample, then the share of the window at 60 s ----
  tm = Date.now();
  const formSet = new Set<number>();
  for (const o of outs) for (let k = 0; k < o.form.length; k += 2) formSet.add(o.form[k]! * N + o.form[k + 1]!);
  const fp = new Int32Array(formSet.size * 2);
  let q = 0;
  for (const key of formSet) { fp[q++] = Math.floor(key / N); fp[q++] = key % N; }
  const FCH = 400, ftasks = [];
  for (let p = 0; p < fp.length; p += FCH * 2) ftasks.push({ type: 'formFrac', pairs: fp.subarray(p, Math.min(fp.length, p + FCH * 2)), t0Ms: t0, t1Ms: t1, stepMs: 60_000, km: FORM_KM });
  const fouts = await pool.map<Float64Array>(ftasks);
  const formation = new Set<number>();
  const formationPairs: Array<[number, number]> = [];
  for (const f of fouts) for (let k = 0; k < f.length; k += 4) if (f[k + 2]! > FORM_FRAC) { formation.add(f[k]! * N + f[k + 1]!); formationPairs.push([objs[f[k]!]!.noradId, objs[f[k + 1]!]!.noradId]); }
  const formSteps = Math.floor((t1 - t0) / 60_000);
  timing.formation = secs(tm);

  // ---- candidates -> one per encounter (30 s gap) -> exact refine ----
  tm = Date.now();
  const byPair = new Map<number, number[]>();
  let nCand = 0;
  for (const o of outs) for (let k = 0; k < o.cand.length; k += 5) {
    const key = o.cand[k]! * N + o.cand[k + 1]!;
    if (formation.has(key)) continue;
    nCand++;
    const rec = [o.cand[k + 2]!, o.cand[k + 3]!, o.cand[k + 4]!];
    const l = byPair.get(key);
    if (l) l.push(...rec); else byPair.set(key, rec);
  }
  const GAP = Math.round(30 / dtS);
  const enc: number[] = [];
  let longClusters = 0;
  for (const [key, l] of byPair) {
    const recs: Array<[number, number, number]> = [];
    for (let k = 0; k < l.length; k += 3) recs.push([l[k]!, l[k + 1]!, l[k + 2]!]);
    recs.sort((a, b) => a[0] - b[0]);
    let best = recs[0]!, last = recs[0]![0], len = 1;
    const flush = () => { enc.push(Math.floor(key / N), key % N, t0 + best[0] * dtMs + best[1] * 1000); if (len > 10) longClusters++; };
    for (let k = 1; k < recs.length; k++) {
      const r = recs[k]!;
      if (r[0] - last > GAP) { flush(); best = r; len = 0; } else if (r[2] < best[2]) best = r;
      last = r[0]; len++;
    }
    flush();
  }
  const nEnc = enc.length / 3;
  const rtasks = [];
  for (let p = 0; p < enc.length; p += 3 * 1500) rtasks.push({ type: 'refine', buf: Float64Array.from(enc.slice(p, p + 3 * 1500)), win: 4000 });
  const routs = await pool.map<Float64Array>(rtasks);
  const found: Array<[number, number, number, number, number]> = [];
  for (const r of routs) for (let k = 0; k < r.length; k += 5) if (r[k + 2]! < CA_KM) found.push([r[k]!, r[k + 1]!, r[k + 2]!, r[k + 3]!, r[k + 4]!]);
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[3] - b[3]);
  await pool.close();
  timing.refine = secs(tm);

  // ---- events with covariance and Pc ----
  tm = Date.now();
  const lite = (o: CatFull): ElsetLite => ({ name: o.name, objectId: String(o.omm.OBJECT_ID), meanMotion: Number(o.omm.MEAN_MOTION), incDeg: Number(o.omm.INCLINATION), raanDeg: Number(o.omm.RA_OF_ASC_NODE) });
  const litePool = objs.map(lite);
  const events: FwdEvent[] = [];
  let dup = 0, outside = 0, evalFail = 0, lastKey = -1, lastT = 0;
  for (const f of found) {
    const key = f[0] * N + f[1];
    if (key === lastKey && Math.abs(f[3] - lastT) < 10_000) { dup++; continue; }
    lastKey = key; lastT = f[3];
    if (f[3] < t0 || f[3] > t1) { outside++; continue; }
    let i = f[0], j = f[1];
    if (objs[i]!.noradId > objs[j]!.noradId) [i, j] = [j, i];
    const feat = classifyCa(litePool[i]!, litePool[j]!, f[2], f[4]);
    const ev = evaluateEvent({ cat: objs[i]!, prop: props[i]! }, { cat: objs[j]!, prop: props[j]! }, f[3], feat.cat,
      { jumpA: jumps.set.has(objs[i]!.noradId), jumpB: jumps.set.has(objs[j]!.noradId) });
    if (!ev) { evalFail++; continue; }
    events.push(ev);
  }
  timing.pc = secs(tm);

  // ---- write ----
  tm = Date.now();
  writeFileSync(batchFile(day, tag), gzipSync(events.map((e) => JSON.stringify(e)).join('\n')));
  timing.write = secs(tm);

  const below = (x: number) => events.filter((e) => e.miss < x).length;
  const above = (k: 'pcBal' | 'pcCons' | 'pcMax' | 'pcBalNoFloor') => ({ gt1e6: events.filter((e) => e[k] > 1e-6).length, gt1e5: events.filter((e) => e[k] > 1e-5).length, gt1e4: events.filter((e) => e[k] > 1e-4).length });
  const pcQ = (k: 'pcBal' | 'pcCons' | 'pcMax') => { const s = events.map((e) => e[k]).sort((a, b) => a - b); return { p50: quantile(s, 0.5), p90: quantile(s, 0.9), p99: quantile(s, 0.99), max: s[s.length - 1] ?? 0 }; };
  const calls = {
    grid: (nSteps + 1) * N,
    formation: (fp.length / 2) * formSteps * 2,
    refine: nEnc * 120, // per encounter: 33 scan points x 2 + 2 + 24 golden x 2 + 2 + final 2 = 120 SGP4 calls (exact, see events-worker.ts refine)
    event: events.length * 2,
  };
  const meta = {
    day, tag, batchTime: new Date(t0).toISOString(), windowEnd: new Date(t1).toISOString(), hours, dtS, workers,
    objects: { historyFile: cc.objs.length + cc.droppedNoEarlier, usedFallbackSetFromPreviousDay: cc.fallback, droppedNoEarlierSet: cc.droppedNoEarlier, fencedIds: fenced, unusableSatrec: unusable, garbageOrbit: garbage, screened: N, identicalGroups: groups.length, identicalObjects: groups.reduce((s, g) => s + g.length, 0) },
    recentJumpFlagsAvailable: jumps.ok, recentJumpObjects: jumps.set.size,
    grid: { cellKm: L, steps: nSteps + 1, pairTests, candidates: nCand, encounters: nEnc, refinedUnder5km: found.length, dupDropped: dup, outsideWindow: outside, longClusters, formationCandidates: formSet.size, formationPairs: formationPairs.length, formationPairList: formationPairs, gridCpuSeconds: +gridCpu.toFixed(1) },
    sgp4Calls: { ...calls, total: calls.grid + calls.formation + calls.refine + calls.event },
    timing: { ...timing, total: secs(T) },
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    events: { lt5: events.length, lt1: below(1), lt05: below(0.5), lt025: below(0.25), evalFailed: evalFail, slowUnder05kms: events.filter((e) => e.slow).length, ageOver14d: events.filter((e) => e.old).length, manoeuvrableEither: events.filter((e) => e.manA || e.manB).length, manoeuvrableBoth: events.filter((e) => e.manA && e.manB).length },
    pcCounts: { balanced: above('pcBal'), conservative: above('pcCons'), max: above('pcMax'), balancedNoFloor: above('pcBalNoFloor') },
    pcQuantiles: { balanced: pcQ('pcBal'), conservative: pcQ('pcCons'), max: pcQ('pcMax') },
  };
  writeFileSync(batchFile(day, tag, 'meta.json'), JSON.stringify(meta, null, 1));
  console.log(`[${day}${tag ? ' ' + tag : ''}] ${N} objects, ${events.length} events <5 km (${meta.events.lt1} <1 km), Pc>1e-5 balanced ${meta.pcCounts.balanced.gt1e5} / conservative ${meta.pcCounts.conservative.gt1e5} / max ${meta.pcCounts.max.gt1e5}; wall ${meta.timing.total} s (grid ${timing.grid}, formation ${timing.formation}, refine ${timing.refine}, pc ${timing.pc}); peak RSS ${meta.maxRssMB} MB`);
  void epochMsOf;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const hours = Number(args.get('hours') ?? 36), dt = Number(args.get('dt') ?? 5), workers = Number(args.get('workers') ?? 3), tag = args.get('tag') ?? '';
  if (args.has('day')) { await runBatch(args.get('day')!, hours, dt, workers, tag); return; }
  const from = args.get('from') ?? '2026-10-12', to = args.get('to') ?? '2026-10-18';
  for (let d = Date.parse(from + 'T00:00:00Z'); d <= Date.parse(to + 'T00:00:00Z'); d += 86_400_000) {
    const day = new Date(d).toISOString().slice(0, 10);
    if (!args.has('force') && existsSync(batchFile(day, tag, 'meta.json'))) { console.log(`[${day}] already done (resume; --force to redo)`); continue; }
    const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--day', day, '--hours', String(hours), '--dt', String(dt), '--workers', String(workers), ...(tag ? ['--tag', tag] : [])], { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`[${day}] batch failed (exit ${r.status})`); process.exit(1); }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
