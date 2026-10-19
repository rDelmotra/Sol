// ============================================================
// SPIKE — not production. Three test questions against starmap.track_run, each checked
// against brute-force SGP4 truth (same catalog, same TEME frame, 1 s sampling unless stated).
//
//   npx tsx packages/backend/scripts/starmap/queries.ts [--table starmap.track_run] [--bucket 30]
//     [--day 2026-10-20] [--catalog path.json] [--hours 6] [--step 20] [--radii 50,100,500] [--margin 100] [--exclude 54922] [--explain] [--label name] [--reps 3]
//
// Q1 who is in this order-2 box in a 10-minute window     (range scan on cell + bucket)
// Q2 occupancy per order-2 box / base shell at one instant (aggregate over a stabbing predicate)
// Q3 who shared an order-4 box with the ISS in 01:00-02:00 (self-join + SGP4 refine) and how many
//    objects came within 500 km that the same-box list caught (do we need neighbour boxes?)
// Truth is cached in /tmp/starmap/truth-*.json so re-runs (compressed, 10-min buckets) are cheap.
// ============================================================

import pg from 'pg';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as satellite from 'satellite.js';
import { cellKey, keyRangeAtMaxOrder, coverBall, alignedKey } from '@orbitwatch/orbital-core';
import { loadCatalog, parseArgs } from './catalog.js';
import { makeProp, windowInCap, type Prop } from './runs.js';

const a = parseArgs(process.argv.slice(2));
const TABLE = a.get('table') ?? 'starmap.track_run';
const BUCKET_MS = Number(a.get('bucket') ?? 30) * 60_000;
const DAY = a.get('day') ?? '2026-10-20';
const HOURS = Number(a.get('hours') ?? 6);
const EXCLUDE = new Set((a.get('exclude') ?? '54922').split(',').map(Number));
const STEP_S = Number(a.get('step') ?? 20);
const RADII = (a.get('radii') ?? '50,100,500').split(',').map(Number);
// Margin on the cover ball: B within R of ISS(t) for t in a slice, ISS moves <= ~7.8 km/s * (step/2 + 1 s bisect slop).
const MARGIN_KM = Number(a.get('margin') ?? 100);
const EXPLAIN = a.has('explain');
const REPS = Number(a.get('reps') ?? 3);
const LABEL = a.get('label') ?? TABLE;
const ISS = 25544;
const D2 = 281474976710656; // 8^16: aligned cell / D2 = order-2 key
const D0 = 18014398509481984; // 8^18: aligned cell / D0 = order-0 key (shell = key % 8 - 1)

const t0Ms = Date.parse(`${DAY}T00:00:00Z`);
const at = (hh: number, mm = 0) => t0Ms + (hh * 60 + mm) * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const bucketOf = (ms: number) => Math.floor(ms / BUCKET_MS) * BUCKET_MS;

// ---- objects that the index covers ----
interface Obj { norad: number; p: Prop }
const objs: Obj[] = [];
for (const o of (a.has('catalog') ? loadCatalog(a.get('catalog')!) : loadCatalog())) {
  if (EXCLUDE.has(o.noradId)) continue;
  const p = makeProp(o.omm);
  if (p && windowInCap(p, t0Ms, t0Ms + HOURS * 3_600_000)) objs.push({ norad: o.noradId, p });
}

function pos(p: Prop, tMs: number): [number, number, number] | null {
  const pv = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = pv ? pv.position : null;
  if (!r || typeof r === 'boolean' || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.z)) return null;
  return [r.x, r.y, r.z];
}

function cached<T>(name: string, fn: () => T): { v: T; secs: number; hit: boolean } {
  const f = `/tmp/starmap/truth-${name}.json`;
  if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); return { v: j.v as T, secs: j.secs as number, hit: true }; }
  const s = Date.now();
  const v = fn();
  const secs = (Date.now() - s) / 1000;
  writeFileSync(f, JSON.stringify({ v, secs }));
  return { v, secs, hit: false };
}

const client = new pg.Client({ connectionString: process.env.STARMAP_DB ?? 'postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch' });

async function timed<R>(sql: string, params: unknown[]): Promise<{ rows: R[]; first: number; med: number }> {
  const ts: number[] = [];
  let rows: R[] = [];
  for (let i = 0; i < REPS; i++) {
    const s = performance.now();
    rows = (await client.query(sql, params)).rows as R[];
    ts.push(performance.now() - s);
  }
  const sorted = [...ts].sort((x, y) => x - y);
  return { rows, first: ts[0]!, med: sorted[Math.floor(sorted.length / 2)]! };
}
async function explain(label: string, sql: string, params: unknown[]): Promise<void> {
  if (!EXPLAIN) return;
  const r = await client.query('EXPLAIN (ANALYZE, BUFFERS OFF, SUMMARY ON) ' + sql, params);
  console.log(`--- EXPLAIN ${label}\n` + r.rows.map((x) => x['QUERY PLAN']).join('\n'));
}
const ms = (x: number) => `${x.toFixed(0)} ms`;
const pct = (x: number) => `${(100 * x).toFixed(3)}%`;

async function q1(): Promise<void> {
  const wS = at(2), wE = at(2, 10), bLo = bucketOf(wS);
  const pick = await client.query(
    `SELECT cell / ${D2} AS box, count(*) AS n FROM ${TABLE} WHERE bucket >= $1 AND bucket < $2 AND t_in < $2 AND t_out > $3 GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
    [iso(bLo), iso(wE), iso(wS)]);
  const box = Number(pick.rows[0].box);
  const [lo, hi] = keyRangeAtMaxOrder(2, box);
  const sql = `SELECT DISTINCT norad_id FROM ${TABLE} WHERE cell >= $1::int8 AND cell < $2::int8 AND bucket >= $3 AND bucket < $4 AND t_in < $4 AND t_out > $5`;
  const params = [lo.toString(), hi.toString(), iso(bLo), iso(wE), iso(wS)];
  await explain('Q1', sql, params);
  const q = await timed<{ norad_id: number }>(sql, params);
  const idx = new Set(q.rows.map((r) => r.norad_id));
  const truth = cached<number[]>(`q1-${DAY}-${box}`, () => {
    const s = new Set<number>();
    for (const o of objs) for (let t = wS; t <= wE; t += 1000) {
      const x = pos(o.p, t);
      if (x && cellKey(2, x[0], x[1], x[2]) === box) { s.add(o.norad); break; }
    }
    return [...s];
  });
  const tr = new Set(truth.v);
  let both = 0; for (const n of tr) if (idx.has(n)) both++;
  console.log(`\n[${LABEL}] Q1 order-2 box ${box} (most rows in window), ${iso(wS)}..${iso(wE)}`);
  console.log(`  index ${idx.size} objects, truth ${tr.size}; recall ${pct(tr.size ? both / tr.size : 1)} (${both}/${tr.size}), precision ${pct(idx.size ? both / idx.size : 1)} (${both}/${idx.size})`);
  console.log(`  query first ${ms(q.first)}, median of ${REPS} ${ms(q.med)}; truth ${truth.secs.toFixed(1)} s${truth.hit ? ' (cached)' : ''}`);
}

async function q2(): Promise<void> {
  const T = at(3), b = iso(bucketOf(T));
  const sqlBox = `SELECT cell / ${D2} AS k, count(*) AS n FROM ${TABLE} WHERE bucket = $1 AND t_in <= $2 AND t_out > $2 GROUP BY 1 ORDER BY 2 DESC`;
  const sqlShell = `SELECT (cell / ${D0}) % 8 - 1 AS k, count(*) AS n FROM ${TABLE} WHERE bucket = $1 AND t_in <= $2 AND t_out > $2 GROUP BY 1 ORDER BY 1`;
  const params = [b, iso(T)];
  await explain('Q2 box', sqlBox, params);
  const qb = await timed<{ k: string; n: string }>(sqlBox, params);
  const qs = await timed<{ k: string; n: string }>(sqlShell, params);
  const truth = cached<{ box: Record<string, number>; shell: Record<string, number>; total: number }>(`q2-${DAY}`, () => {
    const box: Record<string, number> = {}, shell: Record<string, number> = {};
    let total = 0;
    for (const o of objs) {
      const x = pos(o.p, T);
      if (!x) continue;
      const k2 = cellKey(2, x[0], x[1], x[2]);
      const k0 = cellKey(0, x[0], x[1], x[2]);
      if (k2 === null || k0 === null) continue;
      total++;
      box[k2] = (box[k2] ?? 0) + 1;
      shell[(k0 % 8) - 1] = (shell[(k0 % 8) - 1] ?? 0) + 1;
    }
    return { box, shell, total };
  });
  const total = qb.rows.reduce((s, r) => s + Number(r.n), 0);
  let diffBoxes = 0, diffObjs = 0;
  const seen = new Set<string>();
  for (const r of qb.rows) { seen.add(r.k); const d = Math.abs(Number(r.n) - (truth.v.box[r.k] ?? 0)); if (d) { diffBoxes++; diffObjs += d; } }
  for (const [k, n] of Object.entries(truth.v.box)) if (!seen.has(k)) { diffBoxes++; diffObjs += n; }
  const shellDiff = qs.rows.filter((r) => Number(r.n) !== (truth.v.shell[r.k] ?? 0)).length;
  console.log(`\n[${LABEL}] Q2 occupancy at ${iso(T)}`);
  console.log(`  index total ${total} vs brute-force ${truth.v.total} (${total === truth.v.total ? 'EQUAL' : 'DIFF ' + (total - truth.v.total)}); order-2 boxes: ${qb.rows.length} occupied, ${diffBoxes} boxes differ (${diffObjs} objects); base shells: ${qs.rows.length}, ${shellDiff} differ`);
  console.log('  top 10 order-2 boxes: ' + qb.rows.slice(0, 10).map((r) => `${r.k}:${r.n}`).join(' '));
  console.log('  base shells: ' + qs.rows.map((r) => `${r.k}:${r.n}`).join(' '));
  console.log(`  query box-agg first ${ms(qb.first)} median ${ms(qb.med)}; shell-agg first ${ms(qs.first)} median ${ms(qs.med)}; truth ${truth.secs.toFixed(1)} s${truth.hit ? ' (cached)' : ''}`);
}

async function q3(): Promise<void> {
  const wS = at(1), wE = at(2);
  const stepMs = STEP_S * 1000;
  const issObj = objs.find((o) => o.norad === ISS);
  if (!issObj) { console.log('ISS not in catalog'); return; }
  // ISS at 1 s (for refine + truth)
  const n1 = (wE - wS) / 1000 + 1;
  const iss = new Float64Array(n1 * 3);
  for (let i = 0; i < n1; i++) { const x = pos(issObj.p, wS + i * 1000)!; iss.set(x, i * 3); }
  const dist = (x: [number, number, number], i: number) => Math.hypot(x[0] - iss[i * 3]!, x[1] - iss[i * 3 + 1]!, x[2] - iss[i * 3 + 2]!);
  const byId = new Map(objs.map((o) => [o.norad, o.p]));

  const STEP = 5;
  const bf = cached<Array<[number, number]>>(`q3-${DAY}`, () => {
    const out: Array<[number, number]> = [];
    for (const o of objs) {
      if (o.norad === ISS) continue;
      let best = Infinity;
      for (let t = wS; t <= wE; t += STEP * 1000) {
        const x = pos(o.p, t); if (!x) continue;
        const d = dist(x, (t - wS) / 1000);
        if (d < best) best = d;
      }
      if (best < Infinity) out.push([o.norad, best]);
    }
    return out;
  });
  console.log(`\n[${LABEL}] Q3 v2 objects within R km of ISS (${ISS}), ${iso(wS)}..${iso(wE)}; ball cover order 4 per ${STEP_S} s slice, margin ${MARGIN_KM} km (brute-force truth at ${STEP} s sampling: ${bf.secs.toFixed(1)} s${bf.hit ? ', cached' : ''})`);
  console.log('  R km | cover cells/slice | tuples | candidates | caught/truth (catch) | refined<R | extra vs truth | false pos (cand not <R) | cover s | query first/median | refine s');

  for (const R of RADII) {
    const cs = Date.now();
    const sTs: string[] = [], eTs: string[] = [], bks: string[] = [], cells: string[] = [];
    let cellsTotal = 0, slices = 0;
    const align = new Map<number, string>();
    for (let s = wS; s < wE; s += stepMs, slices++) {
      const e = Math.min(s + stepMs, wE);
      const c = issObj.p && pos(issObj.p, (s + e) / 2)!;
      const keys = coverBall(4, c[0], c[1], c[2], R + MARGIN_KM);
      cellsTotal += keys.length;
      for (const k of keys) {
        let al = align.get(k);
        if (al === undefined) { al = alignedKey(4, k).toString(); align.set(k, al); }
        sTs.push(iso(s)); eTs.push(iso(e)); bks.push(iso(bucketOf(s))); cells.push(al);
      }
    }
    const coverSecs = (Date.now() - cs) / 1000;
    // Step 1 (MATERIALIZED CTE) lets the planner prune on constants (bucket range, cell list) instead of
    // hash-joining the whole table; step 2 joins the few matching rows to the per-slice tuples.
    const sql = `WITH c AS MATERIALIZED (
        SELECT cell, bucket, norad_id, t_in, t_out FROM ${TABLE}
        WHERE bucket >= $5 AND bucket < $6 AND cell = ANY($7::int8[]) AND t_in < $6 AND t_out > $5 AND norad_id <> ${ISS})
      SELECT c.norad_id, GREATEST(c.t_in, s.ts) AS s, LEAST(c.t_out, s.te) AS e
      FROM c JOIN unnest($1::timestamptz[], $2::timestamptz[], $3::timestamptz[], $4::int8[]) AS s(ts, te, bk, cell)
        ON c.cell = s.cell AND c.bucket = s.bk AND c.t_in < s.te AND c.t_out > s.ts`;
    const params = [sTs, eTs, bks, cells, iso(bucketOf(wS)), iso(wE), [...new Set(cells)]];
    if (R === RADII[0]) await explain('Q3v2', sql, params);
    const q = await timed<{ norad_id: number; s: Date; e: Date }>(sql, params);
    const cand = new Map<number, Array<[number, number]>>();
    for (const r of q.rows) {
      const s = Math.max(r.s.getTime(), wS), e = Math.min(r.e.getTime(), wE);
      if (e <= s) continue;
      (cand.get(r.norad_id) ?? cand.set(r.norad_id, []).get(r.norad_id)!).push([s, e]);
    }
    const rs = Date.now();
    const refined = new Map<number, number>();
    for (const [n, ivs] of cand) {
      const p = byId.get(n); if (!p) continue;
      let best = Infinity;
      for (const [s, e] of ivs) for (let t = Math.ceil(s / 1000) * 1000; t <= e; t += 1000) {
        const x = pos(p, t); if (!x) continue;
        const d = dist(x, (t - wS) / 1000);
        if (d < best) best = d;
      }
      if (best < Infinity) refined.set(n, best);
    }
    const refineSecs = (Date.now() - rs) / 1000;
    const truth = bf.v.filter(([, d]) => d < R).map(([n]) => n);
    const caught = truth.filter((n) => (refined.get(n) ?? Infinity) < R);
    const missed = truth.filter((n) => !((refined.get(n) ?? Infinity) < R));
    const within = [...refined].filter(([, d]) => d < R).length;
    const truthSet = new Set(truth);
    const extra = [...refined].filter(([n, d]) => d < R && !truthSet.has(n)).length;
    console.log(`  ${R} | ${(cellsTotal / slices).toFixed(1)} | ${cells.length} | ${cand.size} | ${caught.length}/${truth.length} (${truth.length ? (100 * caught.length / truth.length).toFixed(1) : '-'}%) | ${within} | ${extra} | ${cand.size - within} | ${coverSecs.toFixed(2)} | ${ms(q.first)} / ${ms(q.med)} | ${refineSecs.toFixed(2)}`);
    if (missed.length) console.log(`    MISSED: ${missed.slice(0, 20).join(',')}`);
  }
}

await client.connect();
try {
  console.log(`objects covered by truth: ${objs.length}; table ${TABLE}; bucket ${BUCKET_MS / 60000} min`);
  await q1();
  await q2();
  await q3();
} finally {
  await client.end();
}
