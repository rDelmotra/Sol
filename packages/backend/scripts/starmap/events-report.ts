// SPIKE — not production. Per-day tables from starmap.event_stats + storage per kind (temp tables, so nothing is left behind).
//   npx tsx packages/backend/scripts/starmap/events-report.ts [days|storage|ca|diff]
import pg from 'pg';
import { DB_URL } from './events.js';

const mode = process.argv[2] ?? 'days';
const c = new pg.Client({ connectionString: DB_URL });
await c.connect();
/* eslint-disable @typescript-eslint/no-explicit-any */
const stats = (await c.query('SELECT stats FROM starmap.event_stats ORDER BY day')).rows.map((r: any) => r.stats);
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const mean = (a: number[]) => sum(a) / a.length;
const K = ['object.appeared', 'object.disappeared', 'elements.jump', 'region.pass', 'close.approach', 'close.formation'];

if (mode === 'days') {
  console.log('day | rows: app/dis/jump/region/ca/form | ca<5km | secs: diff/region/ca/total');
  for (const s of stats) console.log([s.day, K.map((k) => s.rows?.[k] ?? 0).join('/'), s.rows?.['close.approach.full_lt5km'], [s.timing.diff?.total, s.timing.region, s.timing.ca ? +(s.timing.ca.grid + s.timing.ca.formation + s.timing.ca.refine).toFixed(1) : '', s.timing.total].join('/')].join(' | '));
  console.log(`days ${stats.length}; mean total ${mean(stats.map((s) => s.timing.total)).toFixed(1)} s, min ${Math.min(...stats.map((s) => s.timing.total))}, max ${Math.max(...stats.map((s) => s.timing.total))}; sum ${(sum(stats.map((s) => s.timing.total)) / 60).toFixed(1)} min`);
  for (const k of K) { const v = stats.map((s) => s.rows?.[k]).filter((x) => x !== undefined) as number[]; console.log(`${k}: days ${v.length}, rows/day mean ${mean(v).toFixed(0)} median ${med(v)} min ${Math.min(...v)} max ${Math.max(...v)}, total ${sum(v)}`); }
  const v = (f: (s: any) => number | undefined) => stats.map(f).filter((x) => x !== undefined) as number[];
  console.log('mean secs per day: diff', mean(v((s) => s.timing.diff?.total)).toFixed(2), 'region', mean(v((s) => s.timing.region)).toFixed(1), 'ca grid', mean(v((s) => s.timing.ca?.grid)).toFixed(1), 'ca formation', mean(v((s) => s.timing.ca?.formation)).toFixed(1), 'ca refine', mean(v((s) => s.timing.ca?.refine)).toFixed(1), 'pool init', mean(v((s) => s.timing.poolInit)).toFixed(1));
  console.log('fenced garbage / unusable / identical groups (mean per day):', mean(v((s) => s.fencedGarbage)).toFixed(1), mean(v((s) => s.unusable)).toFixed(1), mean(v((s) => s.identicalGroups)).toFixed(1));
  const rb = stats.map((s) => s.regionByRegion).filter(Boolean);
  const tot: Record<string, number> = {}; for (const r of rb) for (const [k, n] of Object.entries(r)) tot[k] = (tot[k] ?? 0) + (n as number);
  console.log('raw region passes/day by region (mean):', JSON.stringify(Object.fromEntries(Object.entries(tot).map(([k, n]) => [k, Math.round(n / rb.length)]))), 'all regions', Math.round(sum(Object.values(tot)) / rb.length));
  const bc: Record<string, number> = {}; for (const s of stats) for (const [k, n] of Object.entries(s.regionByClass ?? {})) bc[k] = (bc[k] ?? 0) + (n as number);
  const tt = sum(Object.values(bc)); const byType: Record<string, number> = {};
  for (const [k, n] of Object.entries(bc)) { const t = k.split('|')[0]!; byType[t] = (byType[t] ?? 0) + n; }
  console.log('raw region passes by object type:', JSON.stringify(Object.fromEntries(Object.entries(byType).map(([k, n]) => [k, `${(100 * n / tt).toFixed(1)}%`]))));
}

if (mode === 'ca') {
  const THR = [5, 2, 1, 0.5, 0.25];
  const cats: Record<string, number[]> = {};
  for (const s of stats) for (const [k, a] of Object.entries(s.caCat ?? {})) { const t = (cats[k] ??= THR.map(() => 0)); (a as number[]).forEach((x, i) => (t[i]! += x)); }
  const nd = stats.filter((s) => s.caCat).length;
  console.log(`mean per day over ${nd} days, events with miss below (km): ${THR.join(' / ')}`);
  for (const [k, a] of Object.entries(cats).sort()) console.log(k.padEnd(12), a.map((x) => (x / nd).toFixed(0)).join(' / '));
  const dur: Record<string, number> = {}; for (const s of stats) for (const [k, n] of Object.entries(s.caDurBins ?? {})) dur[k] = (dur[k] ?? 0) + (n as number);
  console.log('time within 5 km (all <5 km events), per day:', JSON.stringify(Object.fromEntries(Object.entries(dur).map(([k, n]) => [k, Math.round(n / nd)]))));
  const fc: Record<string, number> = {}; for (const s of stats) for (const [k, n] of Object.entries(s.caFormationCat ?? {})) fc[k] = (fc[k] ?? 0) + (n as number);
  console.log('formation pairs per day by category:', JSON.stringify(Object.fromEntries(Object.entries(fc).map(([k, n]) => [k, +(n / nd).toFixed(1)]))));
  console.log('daily stored close.approach: min/median/max', Math.min(...stats.map((s) => s.rows['close.approach'])), med(stats.map((s) => s.rows['close.approach'])), Math.max(...stats.map((s) => s.rows['close.approach'])));
}

if (mode === 'diff') {
  const sumObj = (f: (s: any) => Record<string, number> | undefined) => { const o: Record<string, number> = {}; for (const s of stats) for (const [k, n] of Object.entries(f(s) ?? {})) o[k] = (o[k] ?? 0) + n; return o; };
  const ds = stats.filter((s) => s.diff);
  console.log('diff days', ds.length, 'appeared by class', JSON.stringify(sumObj((s) => s.diff?.appClass)), 'disappeared by class', JSON.stringify(sumObj((s) => s.diff?.disClass)), 'jump dir', JSON.stringify(sumObj((s) => s.diff?.jumpDir)));
  console.log('changed element sets/day', mean(ds.map((s) => s.diff.changedElsets)).toFixed(0), 'jump failures/day', mean(ds.map((s) => s.diff.jumpFailed)).toFixed(2));
}

if (mode === 'storage') {
  // one temp table per kind with the same indexes as the real table: heap + indexes measured exactly
  const out: any[] = [];
  const days = (await c.query('SELECT count(DISTINCT day)::int AS n FROM starmap.event')).rows[0].n as number;
  for (const k of K) {
    await c.query('DROP TABLE IF EXISTS pg_temp.sz');
    await c.query('CREATE TEMP TABLE sz (LIKE starmap.event INCLUDING ALL)');
    await c.query('INSERT INTO sz (day, kind, subjects, t_start, t_end, payload) SELECT day, kind, subjects, t_start, t_end, payload FROM starmap.event WHERE kind = $1 ORDER BY id', [k]);
    await c.query('VACUUM ANALYZE sz');
    const r = (await c.query("SELECT count(*)::bigint AS n, pg_relation_size('sz') AS heap, pg_indexes_size('sz') AS idx, pg_total_relation_size('sz') AS tot FROM sz")).rows[0];
    out.push({ kind: k, rows: Number(r.n), heapMB: +(r.heap / 1e6).toFixed(1), indexMB: +(r.idx / 1e6).toFixed(1), totalMB: +(r.tot / 1e6).toFixed(1) });
  }
  // raw (one row per pass) form of region.pass for one day, to compare with the packed form
  const day = '2026-09-30';
  await c.query('DROP TABLE IF EXISTS pg_temp.sz');
  await c.query('CREATE TEMP TABLE sz (LIKE starmap.event INCLUDING ALL)');
  const codes: Record<string, string> = { IN: 'india', US: 'usa_conus', EU: 'europe', CN: 'china', BR: 'brazil', AU: 'australia', JP: 'japan', BLR: 'bangalore_500km' };
  await c.query(`INSERT INTO sz (day, kind, subjects, t_start, t_end, payload)
    SELECT e.day, 'region.pass', e.subjects, e.day + (split_part(seg, '-', 1))::int * interval '1 second', e.day + (split_part(seg, '-', 2))::int * interval '1 second', jsonb_build_object('r', ($2::jsonb ->> kv.key))
    FROM starmap.event e, jsonb_each_text(e.payload) kv, regexp_split_to_table(kv.value, ';') seg WHERE e.kind = 'region.pass' AND e.day = $1`, [day, JSON.stringify(codes)]);
  await c.query('VACUUM ANALYZE sz');
  const raw = (await c.query("SELECT count(*)::bigint AS n, pg_total_relation_size('sz') AS tot FROM sz")).rows[0];
  console.log('region.pass one day raw form (one row per pass):', Number(raw.n), 'rows', (raw.tot / 1e6).toFixed(1), 'MB incl. indexes');
  const all = (await c.query("SELECT pg_total_relation_size('starmap.event') AS t, pg_relation_size('starmap.event') AS h, pg_indexes_size('starmap.event') AS i")).rows[0];
  console.log(`days in table: ${days}; starmap.event total ${(all.t / 1e6).toFixed(1)} MB (heap ${(all.h / 1e6).toFixed(1)} + indexes ${(all.i / 1e6).toFixed(1)})`);
  console.log('kind | rows | heap MB | index MB | total MB | MB/day | rows/day | 5-year GB | 5-year rows');
  let tot5 = 0;
  for (const o of out) { const gb = (o.totalMB / days) * 1826 / 1000; tot5 += gb; console.log([o.kind, o.rows, o.heapMB, o.indexMB, o.totalMB, (o.totalMB / days).toFixed(2), (o.rows / days).toFixed(0), gb.toFixed(2), Math.round(o.rows / days * 1826)].join(' | ')); }
  console.log('sum of kinds 5-year GB', tot5.toFixed(1));
}
await c.end();
