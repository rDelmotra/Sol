// ============================================================
// SPIKE — not production. Daily "Layer 3" job: derive the day's events once and append them to starmap.event.
//   export STARMAP_DB=postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch
//   npx tsx packages/backend/scripts/starmap/derive-day.ts --from 2026-09-20 --to 2026-10-18
//     [--only diff,region,ca]   which parts to run (default all); a part rewrites only its own kinds for the day
//     [--force]                 redo days already derived (default: skip a day whose three parts are all recorded in starmap.event_stats)
//     [--workers 4]  [--ca-full] (also write the whole < 5 km set of the day to data/events/ca-full-DAY.jsonl.gz)
//     [--region-mode packed|raw]  [--dry] [--dump file.json]
// Day D = UTC [D 00:00, D+1 00:00) using the catalog file of day D (its element sets end at D+1 00:00).
// diff kinds (appeared / disappeared / jump) compare with the previous day's catalog (skipped for the first day).
// A day is written in ONE transaction (delete that day's kinds, insert, record stats), so a crash leaves no half day;
// re-running the same command resumes at the first day not yet recorded.
// ============================================================
import { readFileSync, appendFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { geodeticLatAltFromEr, ER_KM } from '@orbitwatch/orbital-core';
import { parseArgs } from './catalog.js';
import { makeProp, type Prop } from './runs.js';
import { EvPool } from './events-pool.js';
import {
  REGION_CODES, EVENTS_DIR, DAY_MS, DDL, DB_URL, HISTORY_DIR, REGIONS, contiguousDays, dayStartMs, prevDay, loadDayCatalog, identicalGroups,
  jumpMetrics, posAt, epochMsOf, insertEvents, type EventRow, type CatFull,
} from './events.js';
import type { CaOut } from './events-worker.js';
import { classifyCa, type ElsetLite } from './events-ca.js';

const args = parseArgs(process.argv.slice(2));
const ALL_DAYS = contiguousDays();
const FROM = args.get('from') ?? ALL_DAYS[0]!, TO = args.get('to') ?? FROM;
const DRY = args.has('dry');
const ONLY = new Set((args.get('only') ?? 'diff,region,ca').split(','));
const CA_HOURS = args.has('ca-hours') ? Number(args.get('ca-hours')) : 24;
const CA_DT_S = Number(args.get('ca-dt') ?? 5);
const FULL_CA = args.has('ca-full'); // also write the whole < 5 km set of the day to data/events/ca-full-DAY.jsonl.gz (on-demand evidence)
const FORCE = args.has('force');
const WORKERS = Number(args.get('workers') ?? 4);
const REGION_MODE = args.get('region-mode') ?? 'packed'; // raw | packed
const REGION_SET = args.get('region-set') ?? 'all'; // all | payload (objectType not debris/rocket_body)

// ---- thresholds (see jump-dist.ts: LEO p50 dpos = 1.63 km -> 10x = 16.3 km) ----
export const JUMP_DPOS_KM = 16.3;
/** A jump is stored when the old set, propagated to the new epoch, is > 16.3 km off (10x the LEO median error), AND the semi-major axis
 *  changed by > 1 km, AND by > 1 km even after removing the drag the old set predicted. */
export const JUMP_DA_KM = 1.0;
export const CA_KM = 5;
/** Stored close.approach: unrelated objects (category 'crossing') with a miss distance under this (km). Public element error is ~1 km. */
export const CA_STORE_KM = 1;
/** ... and relative speed at least this (km/s); the category (crossing / same_family / same_launch) is only a payload label. */
export const CA_MIN_V = 0.5;
export const FORM_KM = 50;
export const FORM_FRAC = 0.5;

const secs = (t: number) => +((Date.now() - t) / 1000).toFixed(2);

// ---- lazily built context: first-seen day per NORAD id (all catalog files) and SATCAT status (hindsight) ----
let firstSeen: Map<number, string> | null = null;
function getFirstSeen(): Map<number, string> {
  if (firstSeen) return firstSeen;
  const f = EVENTS_DIR + 'firstseen.json';
  if (existsSync(f)) return (firstSeen = new Map(Object.entries(JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>).map(([k, v]) => [Number(k), v])));
  const days = readFileSyncDays();
  const m = new Map<number, string>();
  for (const d of days) for (const o of loadDayCatalog(d)) if (!m.has(o.noradId)) m.set(o.noradId, d);
  writeFileSync(f, JSON.stringify(Object.fromEntries(m)));
  return (firstSeen = m);
}
function readFileSyncDays(): string[] {
  return readdirSync(HISTORY_DIR).filter((f) => /^catalog-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(8, 18)).sort();
}
let liveSet: Set<number> | null = null;
/** NORAD ids in the live catalog (tle-cache.json, fetched 2026-10-22): present there means certainly not decayed. */
function liveIds(): Set<number> {
  if (!liveSet) liveSet = new Set((JSON.parse(readFileSync(HISTORY_DIR + '../tle-cache.json', 'utf8')) as Array<{ noradId: number }>).map((o) => o.noradId));
  return liveSet;
}
let satcat: Map<number, string> | null = null;
function getSatcat(): Map<number, string> {
  if (satcat) return satcat;
  const d = JSON.parse(gunzipSync(readFileSync(new URL('../../enrichment-data/metadata-enrichment.json.gz', import.meta.url))).toString()) as { objects: Record<string, { noradId: number; orbitalStatus: string }> };
  satcat = new Map(Object.values(d.objects).map((o) => [o.noradId, o.orbitalStatus]));
  return satcat;
}

// ---- 1. appeared / disappeared / jump ----
function diffEvents(day: string, prev: CatFull[], cur: CatFull[]) {
  const t0 = dayStartMs(day);
  const tAll = Date.now();
  const rows: EventRow[] = [];
  const pm = new Map(prev.map((o) => [o.noradId, o])), cm = new Map(cur.map((o) => [o.noradId, o]));
  const fs = getFirstSeen(), sc = getSatcat();
  let tt = Date.now();
  const stat: Record<string, unknown> = {};
  // appeared
  const appClass: Record<string, number> = {};
  for (const o of cur) {
    if (pm.has(o.noradId)) continue;
    const seen = fs.get(o.noradId);
    const launch = o.launchDate ? Date.parse(o.launchDate) : NaN;
    const cls = Number.isFinite(launch) && t0 - launch < 31 * DAY_MS ? 'new_launch' : seen && seen < day ? 'returned' : 'newly_cataloged';
    appClass[cls] = (appClass[cls] ?? 0) + 1;
    rows.push({ kind: 'object.appeared', subjects: [o.noradId], tStart: epochMsOf(o.omm), tEnd: epochMsOf(o.omm), payload: { cls, reg: o.regime, perigee: o.perigee, apogee: o.apogee, launch: o.launchDate, name: o.name } });
  }
  const nApp = rows.length;
  const tApp = secs(tt); tt = Date.now();
  // disappeared
  const disClass: Record<string, number> = {};
  const confusion: Record<string, number> = {};
  for (const o of prev) {
    if (cm.has(o.noradId)) continue;
    const ep = epochMsOf(o.omm);
    const ageDays = (t0 - ep) / DAY_MS;
    const p = makeProp(o.omm);
    let altKm: number | null = null;
    const pos = p ? posAt(p, t0) : null;
    if (pos) altKm = geodeticLatAltFromEr({ x: pos[0] / ER_KM, y: pos[1] / ER_KM, z: pos[2] / ER_KM }).altKm;
    const perigee = o.perigee ?? NaN;
    // Elements alone cannot say "decayed" vs "aged out of the 30-day window": an object that stopped being tracked 30 days
    // ago looks the same either way. So: a low last perigee / low propagated height is a decay signature (checked FIRST),
    // otherwise stale if the last elements are about 30 days old, otherwise unexplained.
    const cls = altKm === null || altKm < 140 || perigee < 250 ? 'decay_likely' : perigee < 350 && ageDays >= 28 ? 'ambiguous_low' : ageDays >= 28 ? 'stale_window' : 'unexplained';
    const inLive = liveIds().has(o.noradId);
    const truth = sc.get(o.noradId) ?? 'unknown'; // GCAT snapshot of 2026-07-03: older than these days, so NOT a truth for them; kept only as a hint
    disClass[cls] = (disClass[cls] ?? 0) + 1;
    confusion[`${cls}|${truth}`] = (confusion[`${cls}|${truth}`] ?? 0) + 1;
    rows.push({ kind: 'object.disappeared', subjects: [o.noradId], tStart: t0, tEnd: t0, payload: {
      cls, satcat: truth, live: inLive ? 1 : 0, reg: o.regime, ageDays: +ageDays.toFixed(2), perigee: o.perigee, apogee: o.apogee,
      bstar: Number(o.omm.BSTAR), mmdot: Number(o.omm.MEAN_MOTION_DOT), altKm: altKm === null ? null : +altKm.toFixed(1), lastEpoch: o.omm.EPOCH, name: o.name } });
  }
  const nDis = rows.length - nApp;
  const tDis = secs(tt); tt = Date.now();
  // jumps
  const jm = jumpMetrics(prev, cur);
  let nJump = 0;
  const byDir: Record<string, number> = {};
  for (const m of jm.metrics) {
    if (!(m.dposKm > JUMP_DPOS_KM && Math.abs(m.daKm) > JUMP_DA_KM && Math.abs(m.residKm) > JUMP_DA_KM)) continue;
    nJump++;
    const dir = m.daKm > 0 ? 'raise' : 'lower';
    byDir[dir] = (byDir[dir] ?? 0) + 1;
    rows.push({ kind: 'elements.jump', subjects: [m.norad], tStart: m.prevEpochMs, tEnd: m.newEpochMs, payload: {
      dpos: +m.dposKm.toFixed(2), da: +m.daKm.toFixed(3), resid: +m.residKm.toFixed(3), dinc: +m.dIncDeg.toFixed(4), along: +m.dAlong.toFixed(2), gap: +m.gapDays.toFixed(2), dir, reg: m.regime, name: m.name } });
  }
  const tJump = secs(tt);
  stat.diff = { appeared: nApp, disappeared: nDis, jumps: nJump, changedElsets: jm.metrics.length, jumpFailed: jm.failed, appClass, disClass, confusion, jumpDir: byDir };
  return { rows, nApp, nDis, nJump, secs: { appeared: tApp, disappeared: tDis, jump: tJump, total: secs(tAll) }, stat };
}

// ---- 2. propagation context for the pool ----
function buildCtx(cur: CatFull[], t0: number, t1: number) {
  const objs: CatFull[] = [];
  let fenced = 0, failed = 0;
  for (const o of cur) {
    const p: Prop | null = makeProp(o.omm);
    if (!p) { failed++; continue; }
    // garbage-orbit fence: radius below the surface (or absurd) at start / middle / end of the day
    let bad = false;
    for (const tm of [t0, (t0 + t1) / 2, t1]) {
      const r = posAt(p, tm);
      if (!r) { bad = true; break; }
      const rad = Math.hypot(r[0], r[1], r[2]);
      if (rad < 6340 || rad > 1e6) { bad = true; break; }
    }
    if (bad) { fenced++; continue; }
    objs.push(o);
  }
  return { objs, fenced, failed };
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DB_URL });
  if (!DRY) { await client.connect(); await client.query(DDL); }
  const days = ALL_DAYS.filter((d) => d >= FROM && d <= TO);
  if (ONLY.has('diff')) { const tl = Date.now(); getFirstSeen(); getSatcat(); console.log(`one-time context load (first-seen index, SATCAT status): ${secs(tl)}s`); }
  mkdirSync(EVENTS_DIR, { recursive: true });
  const done = new Set<string>();
  const caOnly = ONLY.size === 1 && ONLY.has('ca');
  if (!DRY && !FORCE) for (const r of (await client.query(caOnly ? "SELECT day::text AS d FROM starmap.event_stats WHERE stats->>'caDef' = 'v2'" : "SELECT day::text AS d FROM starmap.event_stats WHERE jsonb_array_length(stats->'parts') = 3")).rows as Array<{ d: string }>) done.add(r.d);
  for (const day of days) {
    if (done.has(day)) { console.log(`${day}  already derived (resume: skipped; --force to redo)`); continue; }
    const T = Date.now();
    const t0 = dayStartMs(day), t1 = t0 + DAY_MS;
    const cur = loadDayCatalog(day);
    const hasPrev = day > ALL_DAYS[0]!;
    const prev = hasPrev ? loadDayCatalog(prevDay(day)) : [];
    const timing: Record<string, number | Record<string, number>> = { load: secs(T) };
    const stats: Record<string, unknown> = { day, objects: cur.length, workers: WORKERS };
    const rows: EventRow[] = [];
    const perKind: Record<string, number> = {};

    if (ONLY.has('diff') && hasPrev) {
      const d = diffEvents(day, prev, cur);
      rows.push(...d.rows);
      Object.assign(stats, d.stat);
      timing.diff = d.secs;
      perKind['object.appeared'] = d.nApp; perKind['object.disappeared'] = d.nDis; perKind['elements.jump'] = d.nJump;
    }

    let pool: EvPool | null = null;
    if (ONLY.has('region') || ONLY.has('ca')) {
      const tc = Date.now();
      const { objs, fenced, failed } = buildCtx(cur, t0, t1);
      const { group, groups } = identicalGroups(objs);
      pool = new EvPool(WORKERS);
      await pool.start({ type: 'init', omm: objs.map((o) => o.omm), group });
      timing.poolInit = secs(tc);
      Object.assign(stats, { propagated: objs.length, fencedGarbage: fenced, unusable: failed, identicalGroups: groups.length, identicalObjects: groups.reduce((s, g) => s + g.length, 0) });
      const N = objs.length;

      // ---- region passes ----
      if (ONLY.has('region')) {
        const tr = Date.now();
        const sel: number[] = [];
        for (let i = 0; i < N; i++) {
          const ot = (objs[i] as unknown as { objectType: string }).objectType;
          if (REGION_SET === 'all' || (ot !== 'debris' && ot !== 'rocket_body')) sel.push(i);
        }
        const idx = Int32Array.from(sel);
        const CH = 400, tasks = [];
        for (let o = 0; o < idx.length; o += CH) tasks.push({ type: 'region', o0: o, o1: Math.min(idx.length, o + CH), idx, t0Ms: t0, t1Ms: t1, stepMs: 20_000 });
        const outs = await pool.map<Float64Array>(tasks);
        const byRegion = new Array(REGIONS.length).fill(0) as number[];
        let nPass = 0, nRows = 0;
        const byClass: Record<string, number> = {};
        const grouped = new Map<number, number[]>(); // obj*8+region -> flat [in,out,flags,...]
        for (const out of outs) for (let k = 0; k < out.length; k += 5) {
          const o = out[k]!, r = out[k + 1]!, fl = out[k + 4]!;
          byRegion[r]!++; nPass++;
          const ck = `${(objs[o] as unknown as { objectType: string }).objectType}|${objs[o]!.regime}`;
          byClass[ck] = (byClass[ck] ?? 0) + 1;
          if (REGION_MODE === 'raw') {
            const payload: Record<string, unknown> = { r: REGIONS[r]!.key };
            if (fl & 1) payload.cs = 1;
            if (fl & 2) payload.ce = 1;
            rows.push({ kind: 'region.pass', subjects: [objs[o]!.noradId], tStart: out[k + 2]!, tEnd: out[k + 3]!, payload });
            nRows++;
          } else {
            const key = o;
            const l = grouped.get(key);
            if (l) l.push(r, out[k + 2]!, out[k + 3]!); else grouped.set(key, [r, out[k + 2]!, out[k + 3]!]);
          }
        }
        if (REGION_MODE !== 'raw') {
          // one row per object per day: payload { IN: "in-out;in-out", US: ... } offsets in whole seconds from the day start
          for (const [o, l] of grouped) {
            const byR = new Map<number, string[]>();
            let tS = Infinity, tE = 0;
            for (let q = 0; q < l.length; q += 3) {
              const r = l[q]!;
              tS = Math.min(tS, l[q + 1]!); tE = Math.max(tE, l[q + 2]!);
              const s0 = `${Math.round((l[q + 1]! - t0) / 1000)}-${Math.round((l[q + 2]! - t0) / 1000)}`;
              (byR.get(r) ?? byR.set(r, []).get(r)!).push(s0);
            }
            const payload: Record<string, string> = {};
            for (const [r, v] of byR) payload[REGION_CODES[r]!] = v.join(';');
            rows.push({ kind: 'region.pass', subjects: [objs[o]!.noradId], tStart: tS, tEnd: tE, payload });
            nRows++;
          }
        }
        const n = nPass;
        stats.regionRows = nRows; stats.regionMode = REGION_MODE; stats.regionSet = REGION_SET; stats.regionObjects = idx.length;
        stats.regionByClass = byClass;
        stats.regionByRegion = Object.fromEntries(REGIONS.map((r, i) => [r.key, byRegion[i]]));
        timing.region = secs(tr);
        perKind['region.pass'] = nRows;
        stats.regionByClass = byClass;
        stats.regionByRegion = Object.fromEntries(REGIONS.map((r, i) => [r.key, byRegion[i]]));
      }

      // ---- close approaches ----
      if (ONLY.has('ca')) {
        const tg = Date.now();
        const dtMs = CA_DT_S * 1000;
        const nSteps = Math.round((CA_HOURS * 3600) / CA_DT_S);
        const slack = 0.5;
        const L = CA_KM + 2 + 20 * (CA_DT_S / 2 + slack) + 1;
        const formEvery = Math.round(1800 / CA_DT_S);
        const SL = Math.round(600 / CA_DT_S);
        const tasks = [];
        for (let s = 0; s <= nSteps; s += SL) tasks.push({ type: 'ca', s0: s, s1: Math.min(nSteps + 1, s + SL), t0Ms: t0, dtMs, L, thr: CA_KM, slack, formEvery, formKm: FORM_KM });
        const outs = await pool.map<CaOut>(tasks);
        const gridWall = secs(tg);
        const cpu = outs.reduce((s, o) => s + o.ms, 0) / 1000;
        const tests = outs.reduce((s, o) => s + o.tests, 0);
        // formation: pairs within 50 km at any half-hourly sample, then fraction of the day at 60 s
        const tf = Date.now();
        const formSet = new Set<number>();
        for (const o of outs) for (let k = 0; k < o.form.length; k += 2) formSet.add(o.form[k]! * N + o.form[k + 1]!);
        const fp = new Int32Array(formSet.size * 2);
        let q = 0;
        for (const key of formSet) { fp[q++] = Math.floor(key / N); fp[q++] = key % N; }
        const FCH = 400, ftasks = [];
        for (let p = 0; p < fp.length; p += FCH * 2) ftasks.push({ type: 'formFrac', pairs: fp.subarray(p, Math.min(fp.length, p + FCH * 2)), t0Ms: t0, t1Ms: t0 + nSteps * dtMs, stepMs: 60_000, km: FORM_KM });
        const fouts = await pool.map<Float64Array>(ftasks);
        const formation = new Set<number>();
        let nForm = 0;
        for (const f of fouts) for (let k = 0; k < f.length; k += 4) {
          if (f[k + 2]! > FORM_FRAC) {
            formation.add(f[k]! * N + f[k + 1]!); nForm++;
            rows.push({ kind: 'close.formation', subjects: [objs[f[k]!]!.noradId, objs[f[k + 1]!]!.noradId].sort((a, b) => a - b), tStart: t0, tEnd: t0 + nSteps * dtMs, payload: { frac: +f[k + 2]!.toFixed(3), minKm: +f[k + 3]!.toFixed(3) } });
          }
        }
        const formWall = secs(tf);
        // approach candidates -> one per encounter -> exact refine
        const tm = Date.now();
        const byPair = new Map<number, number[]>();
        let nCand = 0;
        for (const o of outs) for (let k = 0; k < o.cand.length; k += 5) {
          const key = o.cand[k]! * N + o.cand[k + 1]!;
          if (formation.has(key)) continue;
          nCand++;
          const l = byPair.get(key);
          const rec = [o.cand[k + 2]!, o.cand[k + 3]!, o.cand[k + 4]!];
          if (l) l.push(...rec); else byPair.set(key, rec);
        }
        const GAP = Math.round(30 / CA_DT_S);
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
            if (r[0] - last > GAP) { flush(); best = r; len = 0; }
            else if (r[2] < best[2]) best = r;
            last = r[0]; len++;
          }
          flush();
        }
        const rtasks = [];
        for (let p = 0; p < enc.length; p += 3 * 1500) rtasks.push({ type: 'refine', buf: Float64Array.from(enc.slice(p, p + 3 * 1500)), win: 4000 });
        const routs = await pool.map<Float64Array>(rtasks);
        const found: Array<[number, number, number, number, number]> = [];
        for (const r of routs) for (let k = 0; k < r.length; k += 5) if (r[k + 2]! < CA_KM) found.push([r[k]!, r[k + 1]!, r[k + 2]!, r[k + 3]!, r[k + 4]!]);
        found.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[3] - b[3]);
        let nCa = 0, nCaFull = 0, dup = 0;
        let lastKey = -1, lastT = 0;
        const lite = (o: CatFull): ElsetLite => ({ name: o.name, objectId: String(o.omm.OBJECT_ID), meanMotion: Number(o.omm.MEAN_MOTION), incDeg: Number(o.omm.INCLINATION), raanDeg: Number(o.omm.RA_OF_ASC_NODE) });
        const litePool = objs.map(lite);
        const THR = [5, 2, 1, 0.5, 0.25];
        const catTab: Record<string, number[]> = {};
        const bump = (k: string, d: number) => { const a = (catTab[k] ??= THR.map(() => 0)); THR.forEach((t, i) => { if (d < t) a[i]!++; }); };
        const durBins: Record<string, number> = {};
        const fullLines: string[] = [];
        const stored: Record<string, number> = {};
        for (const f of found) {
          const key = f[0] * N + f[1];
          if (key === lastKey && Math.abs(f[3] - lastT) < 10_000) { dup++; continue; }
          lastKey = key; lastT = f[3];
          if (f[3] < t0 || f[3] >= t0 + nSteps * dtMs) continue; // belongs to the neighbouring day
          nCaFull++;
          const feat = classifyCa(litePool[f[0]]!, litePool[f[1]]!, f[2], f[4]);
          bump(feat.cat, f[2]); bump('ALL', f[2]);
          const db = feat.durS < 1 ? '<1s' : feat.durS < 5 ? '1-5s' : feat.durS < 30 ? '5-30s' : '>=30s';
          durBins[db] = (durBins[db] ?? 0) + 1;
          const ids = [objs[f[0]]!.noradId, objs[f[1]]!.noradId].sort((a, b) => a - b);
          if (FULL_CA) fullLines.push(JSON.stringify([ids[0], ids[1], Math.round(f[3]), +f[2].toFixed(3), +f[4].toFixed(2), feat.cat]));
          if (f[2] >= CA_STORE_KM || f[4] < CA_MIN_V) continue; // slow co-moving pairs belong to formation, not here
          nCa++;
          stored[feat.cat] = (stored[feat.cat] ?? 0) + 1;
          rows.push({ kind: 'close.approach', subjects: ids, tStart: Math.round(f[3]), tEnd: Math.round(f[3]), payload: { d: +f[2].toFixed(3), v: +f[4].toFixed(2), cat: feat.cat } });
        }
        if (FULL_CA) writeFileSync(EVENTS_DIR + `ca-full-${day}.jsonl.gz`, gzipSync(fullLines.join('\n')));
        // what the formation pairs are (twin elements / same launch / same family)
        const formCat: Record<string, number> = {};
        for (const r of rows) if (r.kind === 'close.formation') {
          const ia = objs.findIndex((o) => o.noradId === r.subjects[0]), ib = objs.findIndex((o) => o.noradId === r.subjects[1]);
          const ft = classifyCa(litePool[ia]!, litePool[ib]!, 0, 99);
          const k = ft.twin ? 'twin' : ft.sameLaunch ? 'same_launch' : ft.sameFamily ? 'same_family' : 'other';
          formCat[k] = (formCat[k] ?? 0) + 1;
        }
        stats.caCat = catTab; stats.caStoredByCat = stored; stats.caDef = 'v2'; stats.caDurBins = durBins; stats.caFormationCat = formCat; stats.caFullKm5 = nCaFull;
        timing.ca = { grid: gridWall, gridCpu: +cpu.toFixed(1), formation: formWall, refine: secs(tm) };
        perKind['close.approach'] = nCa; perKind['close.approach.full_lt5km'] = nCaFull; perKind['close.formation'] = nForm;
        Object.assign(stats, { ca: { steps: nSteps + 1, dtS: CA_DT_S, cellKm: L, pairTests: tests, candidates: nCand, encounters: enc.length / 3, refinedFound: found.length, dupDropped: dup, longClusters, formationCandidates: formSet.size, formationPairs: nForm } });
      }
      await pool.close();
    }

    if (args.has('dump')) writeFileSync(args.get('dump')!, JSON.stringify(rows));
    const total = secs(T);
    timing.total = total;
    stats.timing = timing; stats.rows = perKind;
    if (!DRY) {
      const tw = Date.now();
      await client.query('BEGIN');
      const kinds = [...(ONLY.has('diff') && hasPrev ? ['object.appeared', 'object.disappeared', 'elements.jump'] : []), ...(ONLY.has('region') ? ['region.pass'] : []), ...(ONLY.has('ca') ? ['close.approach', 'close.formation'] : [])];
      await client.query('DELETE FROM starmap.event WHERE day = $1 AND kind = ANY($2::text[])', [day, kinds]);
      const sz0 = Number((await client.query("SELECT pg_total_relation_size('starmap.event') AS s")).rows[0].s);
      await insertEvents(client, day, rows);
      const sz1 = Number((await client.query("SELECT pg_total_relation_size('starmap.event') AS s")).rows[0].s);
      stats.dbWriteSecs = secs(tw);
      stats.tableDeltaMB = +((sz1 - sz0) / 1e6).toFixed(1);
      const old = (await client.query('SELECT stats->\'parts\' AS p FROM starmap.event_stats WHERE day = $1', [day])).rows[0]?.p as string[] | undefined;
      stats.parts = [...new Set([...(old ?? []), ...ONLY])];
      await client.query('INSERT INTO starmap.event_stats(day, stats) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET stats = starmap.event_stats.stats || EXCLUDED.stats', [day, JSON.stringify(stats)]);
      await client.query('COMMIT');
    }
    appendFileSync(EVENTS_DIR + 'events-stats.jsonl', JSON.stringify(stats) + '\n');
    console.log(`${day}  total ${total}s  rows ${JSON.stringify(perKind)}  timing ${JSON.stringify(timing)}${DRY ? '' : `  db ${stats.dbWriteSecs}s  +${stats.tableDeltaMB} MB`}`);
  }
  if (!DRY) await client.end();
}
await main();
