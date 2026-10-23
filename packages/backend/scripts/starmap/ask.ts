// ============================================================
// SPIKE — not production. The planner: ONE router over all layers (task card T3).
//
//   npx tsx packages/backend/scripts/starmap/ask.ts [--q 1,2,3,4,5,6] [--stage all|routed|brute|compare|report]
//        [--now 2026-10-23T06:30:00Z] [--workers 4]
//   Q4 and Q5 share their runs (stage routed / brute / compare, per-day files in data/ask/); the others do routed + brute
//   in one go and write data/ask/q<N>.json. `--stage report` prints the table from those files.
//   Brute force of Q4/Q5 alone (timing sample): --stage brute --which india|box --days 2026-10-18
//
// Six fixed questions. Each is classified (window x kind), routed by ask-plan.ts to the cheapest layer, run, and ALSO
// run by brute force once; speed-up and agreement are reported.
//   1 who is over India right now                          L4  SGP4 all at one instant + point-in-polygon
//   2 who came within 100 km of the ISS in the last hour   L4  coarse time filter + 1 s refine
//   3 close approaches under 5 km in the last 24 h         L3  lookup (stored subset) ; brute = the whole-day L4 grid
//   4 who passed over India in the last 29 days, and when  L2  hourly order-4 summaries, India rotated in, refine
//   5 who passed through star-map box B in 29 days         L2  hourly order-3 summaries, refine
//   6 every ISS pass over India this month                 L3  lookup, cross-checked with L2 + refine and brute force at 5 s
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import * as satellite from 'satellite.js';
import { decodeKey } from '@orbitwatch/orbital-core';
import { loadCatalog, parseArgs, type CatObj } from './catalog.js';
import { makeProp, windowInCap, posAt as sgpAt, newStats } from './runs.js';
import {
  Pool, dailyDays, COVERAGE_DIR, DAY_MS, GRANS, FENCED, R_MIN_KM, R_MAX_KM, subPoint, inPoly, type DayInfo,
} from './coverage-lib.js';
import { readDay, mergeCover, windowsOf, unindexedNorads } from './coverage-qlib.js';
import { polygonPixelsByTenMin, groupPixels, cellsOf } from './coverage-cover.js';
import { DB_URL, REGIONS, regionContains, loadDayCatalog, dayStartMs, EVENTS_DIR } from './events.js';
import { plan, type Avail, type Question } from './ask-plan.js';
import type { RefineTask, RefineOut, BoxSpec } from './coverage-worker.js';
import type { IssTask, IssOut, PassTask, PassOut } from './ask-worker.js';

const a = parseArgs(process.argv.slice(2));
const WORKERS = Number(a.get('workers') ?? 4);
const NOW = Date.parse(a.get('now') ?? '2026-10-23T06:30:00Z');
const STAGE = a.get('stage') ?? 'all';
const QS = (a.get('q') ?? '1,2,3,4,5,6').split(',').map(Number);
const OUT = COVERAGE_DIR + '../ask/';
mkdirSync(OUT, { recursive: true });
const ISS = 25544;
const TOL_MS = 20_000;
const log = (...x: unknown[]) => console.log(...x);
const now = () => performance.now();
const sec = (t0: number) => +((now() - t0) / 1000).toFixed(3);
const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)]!;
const saveJson = (name: string, o: unknown) => writeFileSync(OUT + name, JSON.stringify(o, null, 1));
const readJson = <T>(name: string): T => JSON.parse(readFileSync(OUT + name, 'utf8')) as T;
const iso = (ms: number) => new Date(ms).toISOString();
const BOX: BoxSpec = JSON.parse(readFileSync(COVERAGE_DIR + 'q/box.json', 'utf8')) as BoxSpec;

// ---------------------------------------------------------------- the six questions + availability
const days29 = dailyDays();
const D29 = days29.map((d) => d.day);
const MONTH = D29.filter((d) => d >= '2026-10-01');
const QUESTIONS: Question[] = [
  { id: 1, text: 'Who is over India right now?', window: 'instant', kind: 'region-in-time' },
  { id: 2, text: 'Who came within 100 km of the ISS in the last hour?', window: 'hours', kind: 'one-vs-all' },
  { id: 3, text: 'Close approaches under 5 km in the last 24 h', window: 'hours', kind: 'all-vs-all', thresholdKm: 5, days: [D29.at(-1)!] },
  { id: 4, text: 'Who passed over India in the last 29 days, and when?', window: 'days', kind: 'region-in-time', days: D29 },
  { id: 5, text: `Who passed through star-map box ${BOX.key} (order 3) in the last 29 days?`, window: 'days', kind: 'box-in-time', days: D29 },
  { id: 6, text: 'Every ISS pass over India this month', window: 'months', kind: 'repeated-fact', days: MONTH, fact: { kind: 'region.pass', region: 'IN' } },
];

async function availability(client: pg.Client): Promise<Avail> {
  const r = await client.query(`SELECT kind, array_agg(DISTINCT day::text) AS d FROM starmap.event GROUP BY kind`);
  const derived: Record<string, Set<string>> = {};
  for (const row of r.rows as Array<{ kind: string; d: string[] }>) derived[row.kind] = new Set(row.d);
  const has = (g: string) => new Set(D29.filter((d) => existsSync(`${COVERAGE_DIR}${d}.${g}.bin`)));
  return { derived, hourly: has('hour'), daily: has('day'), storedApproachKm: 1 };
}

// ---------------------------------------------------------------- generic helpers
type Iv = [number, number];
/** Sort and merge intervals separated by <= gapMs (a gap shorter than the coarse step is invisible to the brute force). */
function mergeIv(iv: Iv[], gapMs: number): Iv[] {
  const s = [...iv].sort((x, y) => x[0] - y[0]);
  const out: Iv[] = [];
  for (const v of s) {
    const l = out[out.length - 1];
    if (l && v[0] - l[1] <= gapMs) l[1] = Math.max(l[1], v[1]); else out.push([v[0], v[1]]);
  }
  return out;
}
interface Match { brute: number; strict: number; covered: number; missing: Iv[]; extra: Iv[]; maxStart: number; maxEnd: number; looseOnly: Iv[] }
/** Every brute pass must appear in the routed answer: strict = start and end both within TOL of one routed pass. */
function matchPasses(brute: Iv[], routed: Iv[], gapMs: number, tol = TOL_MS): Match {
  const R = mergeIv(routed, gapMs), raw = [...routed].sort((x, y) => x[0] - y[0]);
  const m: Match = { brute: brute.length, strict: 0, covered: 0, missing: [], extra: [], maxStart: 0, maxEnd: 0, looseOnly: [] };
  const used = new Set<number>();
  for (const b of brute) {
    // strict: some routed pass (merged across gaps the coarse step cannot see, or the raw piece) has both ends within tol
    let hit: Iv | null = null, cov = false;
    R.forEach((r, k) => { if (r[0] <= b[1] + tol && r[1] >= b[0] - tol) { used.add(k); if (r[0] <= b[0] + tol && r[1] >= b[1] - tol) cov = true; } });
    for (const r of [...R, ...raw]) if (Math.abs(r[0] - b[0]) <= tol && Math.abs(r[1] - b[1]) <= tol) { hit = r; break; }
    if (hit) { m.strict++; m.maxStart = Math.max(m.maxStart, Math.abs(hit[0] - b[0])); m.maxEnd = Math.max(m.maxEnd, Math.abs(hit[1] - b[1])); }
    if (cov) m.covered++;
    if (!hit && !cov) m.missing.push(b);
    if (!hit && cov) m.looseOnly.push(b);
  }
  R.forEach((r, k) => { if (!used.has(k)) m.extra.push(r); });
  return m;
}

// ================================================================ Q1
async function q1(): Promise<void> {
  const cat = loadCatalog();
  const props = cat.map((o) => makeProp(o.omm));
  const st = newStats();
  const routed = (): number[] => {
    const hits: number[] = [];
    props.forEach((p, i) => {
      if (!p || !windowInCap(p, NOW, NOW)) return;
      const pos = sgpAt(p, NOW, st);
      if (!pos) return;
      const r = Math.hypot(pos.x, pos.y, pos.z);
      if (r < R_MIN_KM || r > R_MAX_KM) return;
      const sp = subPoint(pos.x, pos.y, pos.z, NOW);
      if (inPoly(sp.latDeg, sp.lonDeg)) hits.push(cat[i]!.noradId);
    });
    return hits;
  };
  // brute force: separate code path (satellite.propagate on a Date, satellite.eciToGeodetic, events.ts polygon test), no radius filter
  const brute = (): number[] => {
    const hits: number[] = [];
    const gm = satellite.gstime(new Date(NOW));
    for (const o of cat) {
      let satrec;
      try { satrec = satellite.json2satrec(o.omm as Parameters<typeof satellite.json2satrec>[0]); } catch { continue; }
      if (satrec.error) continue;
      const pv = satellite.propagate(satrec, new Date(NOW));
      const pos = pv && typeof pv.position !== 'boolean' ? pv.position : null;
      if (!pos || !Number.isFinite(pos.x)) continue;
      const g = satellite.eciToGeodetic(pos, gm);
      if (regionContains(REGIONS[0]!, satellite.degreesLat(g.latitude), satellite.degreesLong(g.longitude))) hits.push(o.noradId);
    }
    return hits;
  };
  const tR: number[] = [], tB: number[] = [];
  let R: number[] = [], B: number[] = [];
  for (let k = 0; k < 5; k++) { let t = now(); R = routed(); tR.push(sec(t)); t = now(); B = brute(); tB.push(sec(t)); }
  const rs = new Set(R), bs = new Set(B);
  const missing = B.filter((x) => !rs.has(x)), extra = R.filter((x) => !bs.has(x));
  const byReg: Record<string, number> = {};
  const reg = new Map(cat.map((o) => [o.noradId, o.regime]));
  for (const x of R) byReg[reg.get(x)!] = (byReg[reg.get(x)!] ?? 0) + 1;
  const res = {
    q: 1, now: iso(NOW), catalog: cat.length,
    routed: { timeS: median(tR), runs: tR }, brute: { timeS: median(tB), runs: tB },
    answer: { n: R.length, bruteN: B.length, byRegime: byReg },
    agreement: { recall: B.length ? (B.length - missing.length) / B.length : 1, missing, extra },
  };
  saveJson('q1.json', res);
  log(JSON.stringify(res));
}

// ================================================================ Q2
async function q2(): Promise<void> {
  const cat = loadCatalog();
  const issIdx = cat.findIndex((o) => o.noradId === ISS);
  const issP = makeProp(cat[issIdx]!.omm)!;
  const t0Ms = NOW - 3_600_000, nSteps = 3601;
  const iss = new Float64Array(nSteps * 3);
  const st = newStats();
  for (let k = 0; k < nSteps; k++) { const p = sgpAt(issP, t0Ms + k * 1000, st)!; iss.set([p.x, p.y, p.z], k * 3); }
  const pool = new Pool(WORKERS, './ask-worker-boot.mjs');
  const ts = now(); pool.start(); const poolS = sec(ts);
  const R_KM = 100, CH = 400;
  const run = async (coarseS: number): Promise<{ res: Map<number, [number, number]>; wallS: number; evals: number }> => {
    const tasks: IssTask[] = [];
    for (let b = 0; b < cat.length; b += CH) tasks.push({ kind: 'iss', omms: cat.slice(b, b + CH).map((o) => o.omm), base: b, skipIdx: issIdx, t0Ms, nSteps, iss, coarseS, R: R_KM, vmax: 20 });
    const t = now();
    const outs = await pool.map<IssOut>(tasks);
    const wallS = sec(t);
    const res = new Map<number, [number, number]>();
    let evals = 0;
    for (const o of outs) { evals += o.evals; for (let k = 0; k < o.res.length; k += 3) res.set(o.res[k]!, [o.res[k + 1]!, o.res[k + 2]!]); }
    return { res, wallS, evals };
  };
  const rr: Array<Awaited<ReturnType<typeof run>>> = [];
  for (let k = 0; k < 3; k++) rr.push(await run(30));
  const br = await run(0);
  await pool.close();
  const R = rr[0]!.res, B = br.res;
  const missing = [...B.keys()].filter((i) => !R.has(i)), extra = [...R.keys()].filter((i) => !B.has(i));
  let maxDt = 0, maxDd = 0;
  for (const [i, v] of B) { const r = R.get(i); if (r) { maxDt = Math.max(maxDt, Math.abs(r[1] - v[1])); maxDd = Math.max(maxDd, Math.abs(r[0] - v[0])); } }
  const nm = (i: number) => `${cat[i]!.noradId} ${cat[i]!.name}`;
  const colocated = [...B].filter(([, v]) => v[0] < 0.001).length;
  const top = [...B].sort((x, y) => x[1][0] - y[1][0]).filter(([, v]) => v[0] >= 0.001).slice(0, 5).map(([i, v]) => `${nm(i)} ${v[0].toFixed(1)} km at ${iso(t0Ms + v[1] * 1000).slice(11, 19)}`);
  const res = {
    q: 2, now: iso(NOW), window: [iso(t0Ms), iso(NOW)], radiusKm: R_KM, poolStartS: poolS,
    routed: { timeS: median(rr.map((r) => r.wallS)), runs: rr.map((r) => r.wallS), sgp4Evals: rr[0]!.evals },
    brute: { timeS: br.wallS, sgp4Evals: br.evals },
    answer: { n: R.size, bruteN: B.size, identicalElementSetObjects: colocated, closest: top },
    agreement: { recall: B.size ? (B.size - missing.length) / B.size : 1, missing: missing.map(nm), extra: extra.map(nm), maxClosestTimeDiffS: maxDt, maxClosestDistDiffKm: maxDd },
  };
  saveJson('q2.json', res);
  log(JSON.stringify(res));
}

// ================================================================ Q3
interface CaRow { ids: [number, number]; t: number; d: number; v: number; cat: string }
async function q3(client: pg.Client): Promise<void> {
  const day = QUESTIONS[2]!.days![0]!;
  const sql = `SELECT subjects, extract(epoch from t_start)::float8*1000 AS t, payload FROM starmap.event WHERE kind='close.approach' AND day = $1::date`;
  const tR: number[] = [];
  let rows: Array<{ subjects: number[]; t: number; payload: { d: number; v: number; cat: string } }> = [];
  for (let k = 0; k < 5; k++) { const t = now(); rows = (await client.query(sql, [day])).rows; tR.push(sec(t)); }
  const stored: CaRow[] = rows.map((r) => ({ ids: [r.subjects[0]!, r.subjects[1]!], t: r.t, d: r.payload.d, v: r.payload.v, cat: r.payload.cat }));
  const form = Number((await client.query(`SELECT count(*) FROM starmap.event WHERE kind='close.formation' AND day=$1::date`, [day])).rows[0].count);
  // brute force: the whole-day L4 grid (derive-day.ts, close-approach part only, no DB write), 5 s grid + exact refine
  const dump = OUT + `q3-dump-${day}.json`;
  const statsFile = EVENTS_DIR + 'events-stats.jsonl';
  const size0 = existsSync(statsFile) ? statSync(statsFile).size : 0;
  let bruteS: number;
  if (a.has('reuse') && existsSync(dump) && existsSync(OUT + 'q3.json')) bruteS = readJson<{ brute: { timeS: number } }>('q3.json').brute.timeS; // re-compare the files of the last brute run
  else {
    const t = now();
    const sp = spawnSync('npx', ['tsx', 'packages/backend/scripts/starmap/derive-day.ts', '--only', 'ca', '--from', day, '--to', day, '--dry', '--workers', String(WORKERS), '--ca-full', '--dump', dump], { cwd: new URL('../../../../', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 1 << 28 });
    bruteS = sec(t);
    if (sp.status !== 0) throw new Error('derive-day failed: ' + sp.stderr);
    if (existsSync(statsFile) && statSync(statsFile).size > size0) truncateSync(statsFile, size0); // the dry run appended a stats line; remove it
  }
  const full = gunzipSync(readFileSync(EVENTS_DIR + `ca-full-${day}.jsonl.gz`)).toString().trim().split('\n').map((l) => JSON.parse(l) as [number, number, number, number, number, string]);
  const bruteAll: CaRow[] = full.map((r) => ({ ids: [r[0], r[1]], t: r[2], d: r[3], v: r[4], cat: r[5] }));
  // stored definition: miss under 1 km and relative speed >= 0.5 km/s. The full file rounds d to 0.001 km and v to 0.01 km/s, so use the
  // category (co_moving means v < 0.5 exactly) (rounded d of exactly 1.000 is ambiguous and not counted).
  const bruteStored = bruteAll.filter((r) => r.d < 1 && r.cat !== 'co_moving' && r.cat !== 'twin');
  const dumpRows = (JSON.parse(readFileSync(dump, 'utf8')) as Array<{ kind: string; subjects: number[]; tStart: number }>).filter((r) => r.kind === 'close.approach');
  const dumped = dumpRows.length;
  const sk = (ids: number[], t: number) => ids.join('-') + '@' + Math.round(t);
  const dbKeys = new Set(stored.map((r) => sk(r.ids, r.t))), dumpKeys = new Set(dumpRows.map((r) => sk(r.subjects, r.tStart)));
  const dumpVsDb = { onlyInDb: [...dbKeys].filter((x) => !dumpKeys.has(x)).length, onlyInRerun: [...dumpKeys].filter((x) => !dbKeys.has(x)).length };
  const key = (r: CaRow) => `${r.ids[0]}-${r.ids[1]}`;
  const byPair = new Map<string, CaRow[]>();
  for (const r of stored) (byPair.get(key(r)) ?? byPair.set(key(r), []).get(key(r))!).push(r);
  let found = 0, maxDt = 0, maxDd = 0; const missing: string[] = [];
  const usedS = new Set<CaRow>();
  for (const b of bruteStored) {
    const c = (byPair.get(key(b)) ?? []).find((s) => Math.abs(s.t - b.t) <= TOL_MS && !usedS.has(s));
    if (c) { found++; usedS.add(c); maxDt = Math.max(maxDt, Math.abs(c.t - b.t)); maxDd = Math.max(maxDd, Math.abs(c.d - b.d)); } else missing.push(`${key(b)} ${iso(b.t)} ${b.d} km`);
  }
  const extra = stored.filter((s) => !usedS.has(s)); const extraDesc = extra.map((s) => `${key(s)} ${iso(s.t)} d=${s.d} v=${s.v}`);
  const lt = (km: number) => bruteAll.filter((r) => r.d < km).length;
  const res = {
    q: 3, day, routed: { timeS: median(tR), runs: tR, rows: stored.length },
    brute: { timeS: bruteS, method: 'derive-day.ts --only ca --dry --ca-full (5 s grid over all pairs, exact refine)' },
    answer: { storedLookupRows: stored.length, bruteSameDefinition: bruteStored.length, dumpedSameDefinition: dumped, fullUnder5km: bruteAll.length, under2km: lt(2), under1km: lt(1), under05km: lt(0.5), formationPairsExcluded: form },
    agreement: { dumpVsDb, recall: bruteStored.length ? found / bruteStored.length : 1, missing: missing.slice(0, 10), nMissing: missing.length, extra: extra.length, extraDesc, maxTimeDiffS: maxDt / 1000, maxMissDiffKm: maxDd },
  };
  saveJson('q3.json', res);
  log(JSON.stringify(res));
}

// ================================================================ Q4 + Q5
const flat = (m: Map<number, Float64Array>, cat: CatObj[], kind: number): Float64Array => {
  const out: number[] = [];
  for (const [i, iv] of m) { if (FENCED.has(cat[i]!.noradId)) continue; for (let k = 0; k < iv.length; k += 2) out.push(cat[i]!.noradId, kind, iv[k]!, iv[k + 1]!); }
  return Float64Array.from(out);
};
async function refineWins(pool: Pool, mode: 'poly' | 'box', cat: CatObj[], wins: Map<number, number[]>): Promise<{ intervals: Map<number, Float64Array>; wallS: number; items: number }> {
  const idxs = [...wins.keys()], tasks: RefineTask[] = [];
  for (let b = 0; b < idxs.length; b += 50) {
    tasks.push({ kind: 'refine', mode, box: BOX, stepMs: 20_000, nearStepMs: 1000, items: idxs.slice(b, b + 50).map((i) => ({ omm: cat[i]!.omm, windows: wins.get(i)! })) });
  }
  const t = now();
  const res = await pool.map<RefineOut>(tasks);
  const intervals = new Map<number, Float64Array>();
  res.forEach((r, ti) => r.intervals.forEach((iv, k) => { if (iv.length) intervals.set(idxs[ti * 50 + k]!, iv); }));
  return { intervals, wallS: sec(t), items: idxs.length };
}
const HOUR = GRANS.find((g) => g.name === 'hour')!;

async function routedDay(pool: Pool, d: DayInfo): Promise<void> {
  const T = now();
  let t = now();
  const cat = loadCatalog(d.path), n = cat.length;
  const loadS = sec(t); t = now();
  const cov = readDay(d.day, 'hour'), dayFile = readDay(d.day, 'day');
  const openS = sec(t);
  const dropN = unindexedNorads(d.day);
  const always = cat.map((o, i) => (dropN.has(o.noradId) ? i : -1)).filter((i) => i >= 0);
  const stats: Record<string, unknown> = { day: d.day, n, loadS, openS, always: always.length };
  // ---- Q4: India rotated into the star map, order 4, hourly
  {
    t = now();
    const cfg = dayFile.configs.find((c) => c.order === 4)!;
    let lo = Infinity, hi = -Infinity;
    for (const c of cfg.cells) { const nk = decodeKey(4, c).nk; if (nk < lo) lo = nk; if (nk > hi) hi = nk; }
    const grouped = groupPixels(polygonPixelsByTenMin(4, d.startMs), HOUR);
    const memo: number[][] = [];
    const coverS = sec(t); t = now();
    const m = mergeCover(cov, 0, 4, 24, (p) => (memo[p] ??= cellsOf(4, grouped[p]!, lo, hi)));
    for (const i of always) m.cand.fill(1, i * 24, (i + 1) * 24);
    const wins = windowsOf(m.cand, n, 24, d.startMs);
    const mergeS = sec(t);
    const ref = await refineWins(pool, 'poly', cat, wins);
    const fl = flat(ref.intervals, cat, 0);
    writeFileSync(OUT + `routed-india-${d.day}.f64`, new Uint8Array(fl.buffer));
    let cand = 0; for (let i = 0; i < n; i++) for (let p = 0; p < 24; p++) if (m.cand[i * 24 + p]) { cand++; break; }
    let winH = 0; for (const w of wins.values()) for (let k = 0; k < w.length; k += 2) winH += (w[k + 1]! - w[k]!) / 3.6e6;
    stats.q4 = { coverS, mergeS, refineS: ref.wallS, totalS: 0, candObjDays: cand, windowH: winH, objDays: ref.intervals.size, passes: fl.length / 4, lists: m.lists };
  }
  // ---- Q5: box B, order 3, hourly (the cover is the box itself)
  {
    t = now();
    const m = mergeCover(cov, 0, 3, 24, () => [BOX.key]);
    for (const i of always) m.cand.fill(1, i * 24, (i + 1) * 24);
    const wins = windowsOf(m.cand, n, 24, d.startMs);
    const mergeS = sec(t);
    const ref = await refineWins(pool, 'box', cat, wins);
    const fl = flat(ref.intervals, cat, 1);
    writeFileSync(OUT + `routed-box-${d.day}.f64`, new Uint8Array(fl.buffer));
    let cand = 0; for (let i = 0; i < n; i++) for (let p = 0; p < 24; p++) if (m.cand[i * 24 + p]) { cand++; break; }
    let winH = 0; for (const w of wins.values()) for (let k = 0; k < w.length; k += 2) winH += (w[k + 1]! - w[k]!) / 3.6e6;
    stats.q5 = { coverS: 0, mergeS, refineS: ref.wallS, totalS: 0, candObjDays: cand, windowH: winH, objDays: ref.intervals.size, passes: fl.length / 4, lists: m.lists };
  }
  for (const q of ['q4', 'q5'] as const) { const s = stats[q] as Record<string, number>; s.totalS = +(loadS + openS + s.coverS! + s.mergeS! + s.refineS!).toFixed(3); }
  stats.wallS = sec(T);
  saveJson(`routed-${d.day}.json`, stats);
  const s4 = stats.q4 as Record<string, number>, s5 = stats.q5 as Record<string, number>;
  log(`${d.day} routed: wall ${stats.wallS}s | Q4 ${s4.totalS}s (cover ${s4.coverS}, merge ${s4.mergeS}, refine ${s4.refineS}) cand ${s4.candObjDays} -> ${s4.objDays} obj-days/${s4.passes} passes | Q5 ${s5.totalS}s (merge ${s5.mergeS}, refine ${s5.refineS}) cand ${s5.candObjDays} -> ${s5.objDays}/${s5.passes}`);
}

async function bruteDay(pool: Pool, d: DayInfo, which: 'both' | 'india' | 'box'): Promise<void> {
  const T = now();
  let t = now();
  const cat = loadCatalog(d.path);
  const loadS = sec(t); t = now();
  const CH = 200, tasks: PassTask[] = [];
  for (let b = 0; b < cat.length; b += CH) {
    const sl = cat.slice(b, b + CH);
    tasks.push({ kind: 'pass', omms: sl.map((o) => o.omm), norad: sl.map((o) => o.noradId), base: b, startMs: d.startMs, stepMs: 10_000, which, boxOrder: 3, boxKey: BOX.key });
  }
  const outs = await pool.map<PassOut>(tasks);
  const sweepS = sec(t);
  const rows: number[] = []; let calls = 0;
  for (const o of outs) { calls += o.propCalls; for (let k = 0; k < o.passes.length; k += 4) rows.push(cat[o.passes[k]!]!.noradId, o.passes[k + 1]!, o.passes[k + 2]!, o.passes[k + 3]!); }
  const totalS = sec(T);
  const stats: Record<string, unknown> = { day: d.day, which, loadS, sweepS, totalS, propCalls: calls, passesIndia: 0, passesBox: 0 };
  for (let k = 0; k < rows.length; k += 4) stats[rows[k + 1] === 0 ? 'passesIndia' : 'passesBox'] = (stats[rows[k + 1] === 0 ? 'passesIndia' : 'passesBox'] as number) + 1;
  if (which === 'both') {
    writeFileSync(OUT + `brute-${d.day}.i32`, new Uint8Array(Int32Array.from(rows).buffer));
    // cross-check with the T1 cached truth: number of passes per object must be identical
    let diff = 0, checked = 0;
    for (const [kind, ext] of [[0, 'india'], [1, 'box']] as const) {
      const f = `${COVERAGE_DIR}q/truth-${d.day}-${BOX.key}.${ext}`;
      if (!existsSync(f)) continue;
      const b = readFileSync(f), tr = new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      const cnt = new Map<number, number>();
      for (let k = 0; k < rows.length; k += 4) if (rows[k + 1] === kind) cnt.set(rows[k]!, (cnt.get(rows[k]!) ?? 0) + 1);
      cat.forEach((o, i) => { checked++; if ((cnt.get(o.noradId) ?? 0) !== tr[i]!) diff++; });
    }
    stats.vsT1Truth = { objectsChecked: checked, objectsDifferent: diff };
    saveJson(`brute-${d.day}.json`, stats);
  } else saveJson(`brute-one-${which}-${d.day}.json`, stats);
  log(`${d.day} brute (${which}): wall ${totalS}s (load ${loadS}, sweep ${sweepS}) India ${stats.passesIndia} passes, box ${stats.passesBox} passes${which === 'both' ? `; vs T1 cached truth: ${JSON.stringify(stats.vsT1Truth)}` : ''}`);
}

interface Agg { brute: number; strict: number; covered: number; missing: number; extra: number; bruteObjDays: number; objDaysFound: number; routedObjDays: number; routedExtraObjDays: number; maxStart: number; maxEnd: number; missList: string[]; extraShort: number; extraLong: number }
function compareDay(day: string, kind: 0 | 1, startMs: number): Agg {
  const name = kind === 0 ? 'india' : 'box';
  const rb = readFileSync(OUT + `routed-${name}-${day}.f64`), rf = new Float64Array(rb.buffer.slice(rb.byteOffset, rb.byteOffset + rb.length));
  const bb = readFileSync(OUT + `brute-${day}.i32`), bf = new Int32Array(bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.length));
  const R = new Map<number, Iv[]>(), B = new Map<number, Iv[]>();
  for (let k = 0; k < rf.length; k += 4) (R.get(rf[k]!) ?? R.set(rf[k]!, []).get(rf[k]!)!).push([rf[k + 2]!, rf[k + 3]!]);
  for (let k = 0; k < bf.length; k += 4) if (bf[k + 1] === kind) (B.get(bf[k]!) ?? B.set(bf[k]!, []).get(bf[k]!)!).push([startMs + bf[k + 2]! * 1000, startMs + bf[k + 3]! * 1000]);
  const g: Agg = { brute: 0, strict: 0, covered: 0, missing: 0, extra: 0, bruteObjDays: B.size, objDaysFound: 0, routedObjDays: R.size, routedExtraObjDays: 0, maxStart: 0, maxEnd: 0, missList: [], extraShort: 0, extraLong: 0 };
  for (const [id, bi] of B) {
    const m = matchPasses(bi, R.get(id) ?? [], 10_000);
    g.brute += m.brute; g.strict += m.strict; g.covered += m.covered; g.missing += m.missing.length;
    g.maxStart = Math.max(g.maxStart, m.maxStart); g.maxEnd = Math.max(g.maxEnd, m.maxEnd);
    if (R.has(id) && m.covered + m.strict > 0) g.objDaysFound++; else if (!R.has(id) || m.missing.length === m.brute) g.missList.push(`${id}@${day}(${bi.length} brute passes${m.missing.length ? ', first ' + iso(m.missing[0]![0]).slice(11, 19) : ''})`);
    g.extra += m.extra.length;
    for (const e of m.extra) { if (e[1] - e[0] < 10_000) g.extraShort++; else g.extraLong++; }
  }
  for (const [id, ri] of R) if (!B.has(id)) { g.routedExtraObjDays++; const m = mergeIv(ri, 10_000); g.extra += m.length; for (const e of m) { if (e[1] - e[0] < 10_000) g.extraShort++; else g.extraLong++; } }
  return g;
}

async function q45(): Promise<void> {
  const which = (a.get('which') ?? 'both') as 'both' | 'india' | 'box';
  const dsel = a.has('days') ? days29.filter((d) => a.get('days')!.split(',').includes(d.day)) : days29;
  if (STAGE === 'routed' || STAGE === 'all') {
    const pool = new Pool(WORKERS); pool.start();
    for (const d of dsel) { if (existsSync(OUT + `routed-${d.day}.json`) && !a.has('force')) { log(`${d.day} routed cached`); continue; } await routedDay(pool, d); }
    await pool.close();
  }
  if (STAGE === 'brute' || STAGE === 'all') {
    const pool = new Pool(WORKERS, './ask-worker-boot.mjs'); pool.start();
    for (const d of dsel) {
      const f = which === 'both' ? `brute-${d.day}.json` : `brute-one-${which}-${d.day}.json`;
      if (existsSync(OUT + f) && !a.has('force')) { log(`${d.day} brute cached`); continue; }
      await bruteDay(pool, d, which);
    }
    await pool.close();
  }
  if (STAGE === 'compare' || STAGE === 'all') {
    for (const [qn, kind] of [[4, 0], [5, 1]] as const) {
      const tot: Agg = { brute: 0, strict: 0, covered: 0, missing: 0, extra: 0, bruteObjDays: 0, objDaysFound: 0, routedObjDays: 0, routedExtraObjDays: 0, maxStart: 0, maxEnd: 0, missList: [], extraShort: 0, extraLong: 0 };
      let routedS = 0, bruteS = 0, cand = 0, passesR = 0, n = 0;
      const perDay: unknown[] = [];
      for (const d of days29) {
        if (!existsSync(OUT + `routed-${d.day}.json`) || !existsSync(OUT + `brute-${d.day}.json`)) continue;
        const rs = readJson<Record<string, Record<string, number>>>(`routed-${d.day}.json`), bs = readJson<Record<string, number>>(`brute-${d.day}.json`);
        const g = compareDay(d.day, kind, d.startMs);
        n++; routedS += rs[`q${qn}`]!.totalS!; bruteS += bs.totalS!; cand += rs[`q${qn}`]!.candObjDays!; passesR += rs[`q${qn}`]!.passes!;
        for (const k of ['brute', 'strict', 'covered', 'missing', 'extra', 'bruteObjDays', 'objDaysFound', 'routedObjDays', 'routedExtraObjDays', 'extraShort', 'extraLong'] as const) tot[k] += g[k];
        tot.maxStart = Math.max(tot.maxStart, g.maxStart); tot.maxEnd = Math.max(tot.maxEnd, g.maxEnd); tot.missList.push(...g.missList);
        perDay.push({ day: d.day, routedS: rs[`q${qn}`]!.totalS, bruteS: bs.totalS, ...g });
      }
      const one = (w: string) => days29.map((d) => `brute-one-${w}-${d.day}.json`).filter((f) => existsSync(OUT + f)).map((f) => readJson<Record<string, number | string>>(f));
      const res = {
        q: qn, days: n, routed: { timeS: routedS, perDayS: routedS / n, candObjDays: cand, passes: passesR }, brute: { timeS: bruteS, perDayS: bruteS / n, singleQuestionSamples: one(qn === 4 ? 'india' : 'box').map((s) => ({ day: s.day, totalS: s.totalS })) },
        agreement: { brutePasses: tot.brute, passesWithin20sBothEnds: tot.strict, passesCoveredWithin20s: tot.covered, passesNotCovered: tot.missing, passRecallStrict: tot.strict / tot.brute, passRecallCovered: tot.covered / tot.brute,
          bruteObjectDays: tot.bruteObjDays, objectDaysFound: tot.objDaysFound, objectRecall: tot.objDaysFound / tot.bruteObjDays, objectDaysMissing: tot.missList, routedObjectDays: tot.routedObjDays, routedObjectDaysNotInBrute: tot.routedExtraObjDays,
          routedPassesWithoutBrutePartner: tot.extra, ofWhichShorterThan10s: tot.extraShort, ofWhichLonger: tot.extraLong, maxStartDiffS: tot.maxStart / 1000, maxEndDiffS: tot.maxEnd / 1000 },
        perDay,
      };
      saveJson(`q${qn}.json`, res);
      log(JSON.stringify({ ...res, perDay: undefined }));
    }
  }
}

// ================================================================ Q6
async function q6(client: pg.Client): Promise<void> {
  const first = MONTH[0]!, last = MONTH.at(-1)!;
  const sql = `SELECT day::text AS day, payload->>'IN' AS p FROM starmap.event WHERE kind='region.pass' AND subjects @> ARRAY[${ISS}] AND payload ? 'IN' AND day BETWEEN $1::date AND $2::date ORDER BY day`;
  const lookup = async (): Promise<Array<{ day: string; iv: Iv }>> => {
    const r = await client.query(sql, [first, last]);
    const out: Array<{ day: string; iv: Iv }> = [];
    for (const row of r.rows as Array<{ day: string; p: string }>) for (const seg of row.p.split(';')) { const [x, y] = seg.split('-').map(Number); out.push({ day: row.day, iv: [dayStartMs(row.day) + x! * 1000, dayStartMs(row.day) + y! * 1000] }); }
    return out;
  };
  const tL: number[] = []; let L: Array<{ day: string; iv: Iv }> = [];
  for (let k = 0; k < 5; k++) { const t = now(); L = await lookup(); tL.push(sec(t)); }
  // ISS element set of each day (one object per day; production would index this; the whole-file load is not timed)
  const tl = now();
  const iss = new Map<string, Record<string, unknown>>();
  for (const day of MONTH) iss.set(day, loadDayCatalog(day).find((o) => o.noradId === ISS)!.omm);
  const loadS = sec(tl);
  // ---- L2 cross-check: hourly order-4 summaries with India rotated in, candidate windows for the ISS only, exact refine
  const pool = new Pool(WORKERS); pool.start();
  const tc = now();
  const l2: Array<{ day: string; iv: Iv }> = [];
  for (const day of MONTH) {
    const startMs = dayStartMs(day);
    const cov = readDay(day, 'hour'), dayFile = readDay(day, 'day');
    const idx = cov.norad.indexOf(ISS);
    const cfg = dayFile.configs.find((c) => c.order === 4)!;
    let lo = Infinity, hi = -Infinity;
    for (const c of cfg.cells) { const nk = decodeKey(4, c).nk; if (nk < lo) lo = nk; if (nk > hi) hi = nk; }
    const grouped = groupPixels(polygonPixelsByTenMin(4, startMs), HOUR);
    const memo: number[][] = [];
    const m = mergeCover(cov, 0, 4, 24, (p) => (memo[p] ??= cellsOf(4, grouped[p]!, lo, hi)));
    if (unindexedNorads(day).has(ISS)) m.cand.fill(1, idx * 24, (idx + 1) * 24);
    const w = windowsOf(m.cand, cov.n, 24, startMs).get(idx);
    if (!w) continue;
    const out = await pool.map<RefineOut>([{ kind: 'refine', mode: 'poly', box: BOX, stepMs: 20_000, nearStepMs: 1000, items: [{ omm: iss.get(day)!, windows: w }] } satisfies RefineTask]);
    const iv = out[0]!.intervals[0]!;
    for (let k = 0; k < iv.length; k += 2) l2.push({ day, iv: [iv[k]!, iv[k + 1]!] });
  }
  const l2S = sec(tc);
  await pool.close();
  // ---- brute force at 5 s, independent code (satellite.js geodetic + events.ts polygon test)
  const tb = now();
  const brute: Array<{ day: string; iv: Iv }> = [];
  for (const day of MONTH) {
    const p = makeProp(iss.get(day))!;
    const t0 = dayStartMs(day);
    let inside = false, start = 0, lastT = 0;
    for (let t = t0; t < t0 + DAY_MS; t += 5000) {
      const pv = satellite.sgp4(p.satrec, (t - p.epochMs) / 60_000);
      const r = pv && typeof pv.position !== 'boolean' ? pv.position : null;
      let nowIn = false;
      if (r) { const g = satellite.eciToGeodetic(r, satellite.gstime(new Date(t))); nowIn = regionContains(REGIONS[0]!, satellite.degreesLat(g.latitude), satellite.degreesLong(g.longitude)); }
      if (nowIn && !inside) start = t;
      if (!nowIn && inside) brute.push({ day, iv: [start, lastT] });
      if (nowIn) lastT = t;
      inside = nowIn;
    }
    if (inside) brute.push({ day, iv: [start, lastT] });
  }
  const bruteS = sec(tb);
  const cmp = (A: Array<{ day: string; iv: Iv }>, B: Array<{ day: string; iv: Iv }>, gap: number) => {
    const m = matchPasses(A.map((x) => x.iv), B.map((x) => x.iv), gap);
    return { first: m.brute, strict: m.strict, covered: m.covered, notCovered: m.missing.map((x) => `${iso(x[0])}..${iso(x[1])}`), coveredNotStrict: m.looseOnly.map((x) => `${iso(x[0])}..${iso(x[1])}`), extraSecond: m.extra.length, extraDurS: m.extra.map((x) => (x[1] - x[0]) / 1000), maxStartDiffS: m.maxStart / 1000, maxEndDiffS: m.maxEnd / 1000 };
  };
  const res = {
    q: 6, days: [first, last], nDays: MONTH.length,
    routed: { timeS: median(tL), runs: tL, passes: L.length },
    crossCheckL2: { timeS: l2S, passes: l2.length }, brute: { timeS: bruteS, passes: brute.length, stepS: 5 }, issElementLoadS: loadS,
    agreement: { bruteVsLookup: cmp(brute, L, 5000), bruteVsL2: cmp(brute, l2, 5000), lookupVsL2: cmp(L.map((x) => x), l2, 2000) },
  };
  saveJson('q6.json', res);
  log(JSON.stringify(res));
}

// ================================================================ report + main
function report(): void {
  log('\nQ | route | routed s | brute s | speed-up | answer | agreement');
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const f = `q${n}.json`;
    if (!existsSync(OUT + f)) { log(`${n} | (no result)`); continue; }
    const r = readJson<{ routed: { timeS: number }; brute: { timeS: number }; answer?: unknown; agreement: unknown }>(f);
    log(`${n} | routed ${r.routed.timeS.toFixed(4)} | brute ${r.brute.timeS.toFixed(3)} | ${(r.brute.timeS / r.routed.timeS).toFixed(1)}x | ${JSON.stringify(r.answer ?? {})} | ${JSON.stringify(r.agreement).slice(0, 600)}`);
  }
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const av = await availability(client);
  log(`NOW = ${iso(NOW)} (live catalog tle-cache.json); window days ${D29[0]}..${D29.at(-1)}; ${WORKERS} workers`);
  log('PLAN');
  for (const q of QUESTIONS) { const p = plan(q, av); log(`  Q${q.id} ${q.text}\n     window ${q.window}, kind ${q.kind} -> ${p.layer}${p.gran ? ' (' + p.gran + 'ly)' : ''}: ${p.route}\n     why: ${p.why}`); }
  if (STAGE === 'report') { report(); await client.end(); return; }
  if (STAGE === 'all' || STAGE === 'routed' || STAGE === 'brute') {
    if (QS.includes(1) && STAGE === 'all') await q1();
    if (QS.includes(2) && STAGE === 'all') await q2();
    if (QS.includes(3) && STAGE === 'all') await q3(client);
    if (QS.includes(6) && STAGE === 'all') await q6(client);
  }
  if (QS.includes(4) || QS.includes(5)) await q45();
  if (STAGE === 'all') report();
  await client.end();
}
await main();
