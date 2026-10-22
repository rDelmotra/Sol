// SPIKE — not production. Orbit-invariant sieve index benchmark against local docker TimescaleDB.
// usage: tsx invariants-db.ts gen|load|bench
import { readFileSync, createWriteStream, writeFileSync, openSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';

// STARMAP_DB set → plain `psql <url>` (cloud, no Docker); unset → psql inside the local docker container.
const DB = process.env.STARMAP_DB;
const PSQL_BIN = DB ? 'psql' : 'docker';
const PSQL = DB
  ? [DB, '-v', 'ON_ERROR_STOP=1']
  : ['exec', '-i', 'orbitwatch-timescaledb', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'orbitwatch', '-d', 'orbitwatch'];
const here = new URL('.', import.meta.url).pathname;
const sh = (args: string[], input?: string): string =>
  execFileSync(PSQL_BIN, [...PSQL, ...args], { input, encoding: 'utf8', maxBuffer: 1 << 28 });

interface Obj { noradId: number; perigee: number; apogee: number; inclination: number;
  omm: { EPOCH: string; RA_OF_ASC_NODE: number; ECCENTRICITY: number; MEAN_MOTION: number } }
const MU = 398600.4418;
const aKm = (n: number): number => Math.cbrt(MU / ((n * 2 * Math.PI / 86400) ** 2));
const row = (o: Obj, epoch: string, dp: number, da: number, di: number): string => {
  const p = Math.max(o.perigee + dp, -6000), a = Math.max(o.apogee + da, p);
  return `${o.noradId},${epoch},${p},${a},${o.inclination + di},${o.omm.RA_OF_ASC_NODE},${o.omm.ECCENTRICITY},${aKm(o.omm.MEAN_MOTION)}\n`;
};
const rnd = (w: number): number => (Math.random() * 2 - 1) * w;
const clean = (a: Obj[]): Obj[] => a.filter(o => o.perigee != null && o.apogee != null && o.omm && o.apogee >= o.perigee && o.omm.MEAN_MOTION > 0);

async function gen(): Promise<void> {
  const live = clean(JSON.parse(readFileSync(here + '../../data/tle-cache.json', 'utf8')));
  const past = clean(JSON.parse(readFileSync('/tmp/starmap/catalog-2026-07-15.json', 'utf8')));
  writeFileSync('/tmp/starmap/oi-real.csv', live.map(o => row(o, o.omm.EPOCH, 0, 0, 0)).join('') + past.map(o => row(o, o.omm.EPOCH, 0, 0, 0)).join(''));
  const ws = createWriteStream('/tmp/starmap/oi-hist.csv');
  const t0 = Date.parse('2026-05-25T00:00:00Z'); let n = 0;
  for (let d = 0; d < 150; d++) {
    const day = t0 + d * 86400000;
    let buf = '';
    for (const o of live) { // epoch = day d at the object's real time-of-day
      const tod = Date.parse(o.omm.EPOCH) % 86400000;
      buf += row(o, new Date(day + tod).toISOString(), rnd(2), rnd(2), rnd(0.01)); n++;
    }
    if (!ws.write(buf)) await once(ws, 'drain');
  }
  ws.end(); await once(ws, 'finish'); console.log('hist rows', n);
}

function load(): void {
  sh(['-q'], readFileSync(here + 'invariants-db.sql', 'utf8'));
  const cols = '(norad_id,epoch,perigee_km,apogee_km,incl_deg,raan_deg,ecc,a_km)';
  for (const [t, f] of [['orbit_invariant', 'oi-real'], ['orbit_invariant_hist', 'oi-hist']] as const) {
    const s = Date.now();
    execFileSync(PSQL_BIN, [...PSQL, '-q', '-c', `\\copy starmap.${t} ${cols} from stdin with csv`], { stdio: [openSync(`/tmp/starmap/${f}.csv`, 'r'), 'inherit', 'inherit'] });
    console.log(t, 'load s', (Date.now() - s) / 1000);
  }
  sh(['-q', '-c', 'ANALYZE starmap.orbit_invariant', '-c', 'ANALYZE starmap.orbit_invariant_hist']);
}

// ---- bench ----
interface Res { rows: number; ms: number[]; node: string; hit: number }
const planNode = (p: any): string => { const out: string[] = []; const w = (n: any): void => { if (/Scan/.test(n['Node Type'])) out.push(n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : '')); (n.Plans ?? []).forEach(w); }; w(p); return [...new Set(out)].join('+'); };
function run(where: string, table: string, pre: string[] = []): Res {
  const ms: number[] = []; let node = '', hit = 0;
  for (let i = 0; i < 6; i++) { // run 0 = first (cold-ish), 1..5 warm
    const out = sh(['-At', ...pre.flatMap(p => ['-c', p]), '-c', `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT norad_id FROM ${table} WHERE ${where}`]);
    const j = JSON.parse(out.slice(out.indexOf('[')))[0];
    ms.push(j['Execution Time']); node = planNode(j.Plan); hit = j.Plan['Actual Rows'] ?? hit;
  }
  const rows = Number(sh(['-At', '-c', `SELECT count(*) FROM ${table} WHERE ${where}`]).trim());
  return { rows, ms, node, hit };
}
const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const sizeOf = (idx: string): string => sh(['-At', '-c', `SELECT pg_size_pretty(pg_relation_size('starmap.${idx}'))`]).trim();
const out: string[] = [];
function report(q: string, variant: string, r: Res, extra: string): void {
  const line = `${q} | ${variant} | rows ${r.rows} | first ${r.ms[0].toFixed(1)} | median ${med(r.ms.slice(1)).toFixed(2)} ms | ${r.node} | ${extra}`;
  console.log(line); out.push(line);
}

const A = (lo: number, hi: number): string => `perigee_km <= ${hi} AND apogee_km >= ${lo}`;
const QS = {
  'Q-a 400-430': { tbl: 'orbit_invariant', w: A(400, 430), alt: `alt && numrange(400,430,'[]')`, pt: `point(perigee_km,apogee_km) <@ box(point(-1e9,400),point(430,1e9))` },
  'Q-b 540-560 i52-54': { tbl: 'orbit_invariant', w: `${A(540, 560)} AND incl_deg BETWEEN 52 AND 54`, alt: `alt && numrange(540,560,'[]') AND incl_deg BETWEEN 52 AND 54`, pt: `point(perigee_km,apogee_km) <@ box(point(-1e9,540),point(560,1e9)) AND incl_deg BETWEEN 52 AND 54` },
  'Q-c GEO 35700-35900': { tbl: 'orbit_invariant', w: A(35700, 35900), alt: `alt && numrange(35700,35900,'[]')`, pt: `point(perigee_km,apogee_km) <@ box(point(-1e9,35700),point(35900,1e9))` },
};
const DAY = `epoch >= '2026-08-01' AND epoch < '2026-08-02'`, MONTH = `epoch >= '2026-08-01' AND epoch < '2026-08-31'`;

function variants(table: 'orbit_invariant' | 'orbit_invariant_hist', cases: Array<[string, string, string]>, idxs: Array<[string, string, (w: [string, string, string]) => string]>): void {
  for (const [name, ddl, pick] of [['none', '', ''] as [string, string, string], ...idxs.map(i => [i[0], i[1], ''] as [string, string, string])]) {
    let bt = 0;
    if (ddl) { const s = Date.now(); sh(['-q', '-c', `CREATE INDEX ix_tmp ON starmap.${table} ${ddl}`, '-c', `ANALYZE starmap.${table}`]); bt = (Date.now() - s) / 1000; }
    const sz = ddl ? sizeOf('ix_tmp') : '-';
    const pickFn = idxs.find(i => i[0] === name)?.[2];
    for (const c of cases) {
      const where = pickFn ? pickFn(c) : c[1];
      const r = run(where, `starmap.${table}`);
      report(c[0], name, r, `idx ${sz} build ${bt.toFixed(1)}s`);
      if (ddl && /Seq Scan/.test(r.node)) {
        const f = run(where, `starmap.${table}`, ['SET enable_seqscan=off']);
        report(c[0], name + ' [forced idx]', f, `idx ${sz}`);
      }
    }
    if (ddl) sh(['-q', '-c', 'DROP INDEX starmap.ix_tmp']);
  }
}

function bench(): void {
  const cat: Array<[string, string, string]> = Object.entries(QS).map(([k, v]) => [k, v.w, k]);
  const pick = (key: 'alt' | 'pt') => (c: [string, string, string]): string => (QS as any)[c[2]][key];
  console.log('-- catalog table', sh(['-At', '-c', 'select count(*) from starmap.orbit_invariant']).trim());
  variants('orbit_invariant', cat, [
    ['btree(perigee)', '(perigee_km)', c => c[1]],
    ['btree(perigee,apogee)', '(perigee_km, apogee_km)', c => c[1]],
    ['gist(alt)', 'USING gist (alt)', pick('alt')],
    ['gist(point)', 'USING gist ((point(perigee_km,apogee_km)))', pick('pt')],
    ['btree_gist(alt,incl)', 'USING gist (alt, incl_deg)', pick('alt')],
  ]);
  const hc: Array<[string, string, string]> = [
    ['Q-d1 400-430 one day', `${A(400, 430)} AND ${DAY}`, 'd1'], ['Q-d30 400-430 30 days', `${A(400, 430)} AND ${MONTH}`, 'd30']];
  const h = (tail: string) => (c: [string, string, string]): string => (c[2] === 'd1' ? `alt && numrange(400,430,'[]') AND ${DAY}` : `alt && numrange(400,430,'[]') AND ${MONTH}`) + tail;
  console.log('-- hist table', sh(['-At', '-c', 'select count(*) from starmap.orbit_invariant_hist']).trim());
  variants('orbit_invariant_hist', hc, [
    ['btree(epoch)', '(epoch)', c => c[1]],
    ['brin(epoch)', 'USING brin (epoch)', c => c[1]],
    ['gist(alt)', 'USING gist (alt)', h('')],
    ['btree_gist(epoch,alt)', 'USING gist (epoch, alt)', h('')],
    ['btree(epoch,perigee,apogee)', '(epoch, perigee_km, apogee_km)', c => c[1]],
  ]);
  writeFileSync('/tmp/starmap/oi-bench.txt', out.join('\n'));
}

function ht(interval: string): void {
  const t = 'orbit_invariant_hist_ht';
  sh(['-q', '-c', `DROP TABLE IF EXISTS starmap.${t}`, '-c', `CREATE TABLE starmap.${t} (LIKE starmap.orbit_invariant_hist INCLUDING GENERATED)`,
    '-c', `SELECT create_hypertable('starmap.${t}','epoch',chunk_time_interval=>INTERVAL '${interval}',create_default_indexes=>false)`]);
  sh(['-q', '-c', `INSERT INTO starmap.${t}(norad_id,epoch,perigee_km,apogee_km,incl_deg,raan_deg,ecc,a_km) SELECT norad_id,epoch,perigee_km,apogee_km,incl_deg,raan_deg,ecc,a_km FROM starmap.orbit_invariant_hist`]);
  const s = Date.now(); sh(['-q', '-c', `CREATE INDEX ix_ht ON starmap.${t} USING gist (alt)`, '-c', `ANALYZE starmap.${t}`]); const bt = (Date.now() - s) / 1000;
  const sz = sh(['-At', '-c', `SELECT pg_size_pretty(sum(pg_relation_size(c.oid))) FROM pg_class c WHERE relname LIKE '%ix_ht' OR relname LIKE '%_alt_idx'`]).trim();
  for (const [q, w] of [['Q-d1', `alt && numrange(400,430,'[]') AND ${DAY}`], ['Q-d30', `alt && numrange(400,430,'[]') AND ${MONTH}`]]) {
    report(q + ' (hypertable ' + interval + ')', 'gist(alt) per chunk', run(w, `starmap.${t}`), `idx ${sz} build ${bt.toFixed(1)}s`);
  }
  sh(['-q', '-c', `DROP TABLE starmap.${t}`]);
}

const cmd = process.argv[2];
if (cmd === 'gen') await gen(); else if (cmd === 'load') load(); else if (cmd === 'bench') bench(); else if (cmd === 'ht') ht(process.argv[3] ?? '1 day');
else console.log('usage: gen|load|bench|ht [interval]');
