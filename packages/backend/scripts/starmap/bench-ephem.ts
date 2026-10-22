// ============================================================
// SPIKE — not production.
//
// End-to-end benchmark: "positions of every object" via SGP4 (elements -> json2satrec -> sgp4) vs
// stored day lines (rows -> decode -> Chebyshev eval). Single-threaded, same local Postgres for both.
//
//   npx tsx packages/backend/scripts/starmap/bench-ephem.ts [--day 2026-10-20] [--catalog path.json] [--skip 3]
//
// Needs starmap.ephem_day + starmap.elset_day filled by `build-ephem.ts --db`.
// ============================================================
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import * as satellite from 'satellite.js';
import pg from 'pg';
import { BatchEphem } from './ephem.js';
import { DB_URL } from './ephem-db.js';
import { makeProp, type SatRec } from './runs.js';
import { loadCatalog, parseArgs, rng } from './catalog.js';

const args = parseArgs(process.argv.slice(2));
const day = args.get('day') ?? '2026-10-20';
const dayMs = Date.parse(day + 'T00:00:00Z');
const skip = new Set((args.get('skip') ?? '').split(',').filter(Boolean));
const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
const cat = loadCatalog(args.get('catalog'));
const regimeOf = new Map(cat.map((o) => [o.noradId, o.regime]));
const nameOf = new Map(cat.map((o) => [o.noradId, o.name]));

const now = (): number => performance.now();
const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1]!;
const fmt = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);
let sink = 0; // defeats dead-code elimination

interface Phases { fetch: number; setup: number; evalMs: number; n: number }
const total = (p: Phases): number => p.fetch + p.setup + p.evalMs;

// ---------- path A: SGP4 ----------
interface ARec { id: number; sat: SatRec; epochMs: number }
async function fetchA(source: 'db' | 'json', ids: number[] | null): Promise<unknown[]> {
  if (source === 'json') {
    const all = JSON.parse(readFileSync(args.get('catalog') ?? new URL('../../data/tle-cache.json', import.meta.url).pathname, 'utf8')) as Array<{ noradId: number; omm: unknown }>;
    return ids ? all.filter((o) => ids.includes(o.noradId)) : all.map((o) => o);
  }
  const r = ids
    ? await pool.query('SELECT norad_id, omm FROM starmap.elset_day WHERE day=$1 AND norad_id = ANY($2::int[])', [day, ids])
    : await pool.query('SELECT norad_id, omm FROM starmap.elset_day WHERE day=$1', [day]);
  return r.rows.map((x) => ({ noradId: x.norad_id, omm: x.omm }));
}
function setupA(rows: unknown[], idSet: Set<number> | null): ARec[] {
  const out: ARec[] = [];
  for (const r of rows as Array<{ noradId: number; omm: unknown }>) {
    if (idSet && !idSet.has(r.noradId)) continue; // json path holds the 33 fenced objects too; keep the sets equal
    const p = makeProp(r.omm);
    if (p) out.push({ id: r.noradId, sat: p.satrec, epochMs: p.epochMs });
  }
  return out;
}
function evalA(recs: ARec[], instants: number[]): void {
  let acc = 0;
  for (const t of instants) {
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]!;
      const pv = satellite.sgp4(r.sat, (t - r.epochMs) / 60_000);
      const p = pv ? pv.position : null;
      if (p && typeof p !== 'boolean') acc += p.x + p.y + p.z;
    }
  }
  sink += acc;
}

// ---------- path B: day lines ----------
async function fetchB(ids: number[] | null): Promise<{ ids: number[]; bufs: Uint8Array[] }> {
  const r = ids
    ? await pool.query('SELECT norad_id, line FROM starmap.ephem_day WHERE day=$1 AND norad_id = ANY($2::int[])', [day, ids])
    : await pool.query('SELECT norad_id, line FROM starmap.ephem_day WHERE day=$1', [day]);
  return { ids: r.rows.map((x) => x.norad_id as number), bufs: r.rows.map((x) => x.line as Uint8Array) };
}
function evalB(b: BatchEphem, instants: number[]): void {
  const out = new Float64Array(b.count * 3);
  let acc = 0;
  for (const t of instants) { b.evalAll(t, out); acc += out[0]! + out[out.length - 1]!; }
  sink += acc;
}

async function runA(source: 'db' | 'json', ids: number[] | null, idSet: Set<number> | null, instants: number[], reps: number, evalReps: number): Promise<Phases> {
  const f: number[] = [], s: number[] = [], e: number[] = [];
  let n = 0;
  for (let r = 0; r < reps; r++) {
    let t = now(); const rows = await fetchA(source, ids); f.push(now() - t);
    t = now(); const recs = setupA(rows, idSet); s.push(now() - t);
    n = recs.length;
    if (r < evalReps) { t = now(); evalA(recs, instants); e.push(now() - t); }
  }
  return { fetch: median(f), setup: median(s), evalMs: median(e), n };
}
async function runB(ids: number[] | null, instants: number[], reps: number, evalReps: number): Promise<Phases> {
  const f: number[] = [], s: number[] = [], e: number[] = [];
  let n = 0;
  for (let r = 0; r < reps; r++) {
    let t = now(); const rows = await fetchB(ids); f.push(now() - t);
    t = now(); const b = new BatchEphem(rows.bufs); s.push(now() - t);
    n = b.count;
    if (r < evalReps) { t = now(); evalB(b, instants); e.push(now() - t); }
  }
  return { fetch: median(f), setup: median(s), evalMs: median(e), n };
}

function row(name: string, a: Phases, aj: Phases | null, b: Phases): void {
  const p = (x: Phases): string => `fetch ${fmt(x.fetch).padStart(9)} setup ${fmt(x.setup).padStart(9)} eval ${fmt(x.evalMs).padStart(9)} total ${fmt(total(x)).padStart(9)}`;
  console.log(`${name}  (objects: A ${a.n}, B ${b.n})`);
  console.log(`  A sgp4 (db)   ${p(a)}`);
  if (aj) console.log(`  A sgp4 (json) ${p(aj)}`);
  console.log(`  B day lines   ${p(b)}`);
  console.log(`  speedup B vs A(db): total ${(total(a) / total(b)).toFixed(1)}x   eval-only ${(a.evalMs / b.evalMs).toFixed(1)}x` + (aj ? `   vs A(json): total ${(total(aj) / total(b)).toFixed(1)}x` : ''));
}

async function main(): Promise<void> {
  const lineIds = (await pool.query('SELECT norad_id FROM starmap.ephem_day WHERE day=$1', [day])).rows.map((r) => r.norad_id as number);
  const idSet = new Set(lineIds);
  console.log(`bench day ${day}: ${lineIds.length} objects with both elements and a line (single-threaded, node ${process.version})`);
  const rand = rng(42);

  // S1
  const t1 = [dayMs + 13.6 * 3600_000];
  if (!skip.has('1')) row('S1 one instant, all objects', await runA('db', null, null, t1, 3, 3), await runA('json', null, idSet, t1, 3, 3), await runB(null, t1, 3, 3));
  // S2: 1 h at 10 s
  const t2 = Array.from({ length: 360 }, (_, i) => dayMs + 13 * 3600_000 + i * 10_000);
  if (!skip.has('2')) row('S2 1 hour @10 s (360 instants), all objects', await runA('db', null, null, t2, 1, 1), null, await runB(null, t2, 3, 3));
  // S3: day @60 s
  const t3 = Array.from({ length: 1440 }, (_, i) => dayMs + i * 60_000);
  if (!skip.has('3')) row('S3 full day @60 s (1440 instants), all objects', await runA('db', null, null, t3, 1, 1), null, await runB(null, t3, 1, 1));
  // S4: ISS at 1000 random instants
  const iss = [25544];
  const t4 = Array.from({ length: 1000 }, () => dayMs + rand() * 86_400_000);
  if (!skip.has('4')) row('S4 ISS at 1000 random instants', await runA('db', iss, null, t4, 9, 9), null, await runB(iss, t4, 9, 9));
  // S5: 1000 random objects at one instant
  const ids5 = Array.from({ length: 1000 }, () => lineIds[Math.floor(rand() * lineIds.length)]!);
  const uniq5 = [...new Set(ids5)];
  if (!skip.has('5')) row(`S5 ${uniq5.length} random objects at one instant`, await runA('db', uniq5, null, t1, 7, 7), null, await runB(uniq5, t1, 7, 7));

  // ---------- accuracy ----------
  if (!skip.has('acc')) {
    const rows = await fetchB(null);
    const b = new BatchEphem(rows.bufs);
    const recs = new Map(setupA(await fetchA('db', null), null).map((r) => [r.id, r]));
    const BIN = 0.001, NB = 2000; // 1 m bins up to 2 km
    const hist = new Map<string, Float64Array>();
    const maxBy = new Map<string, number>();
    const perObj: Array<[number, number]> = [];
    const out = new Float64Array(3);
    const offs = 37_000; // off the 10 s fit-check grid
    for (let i = 0; i < b.count; i++) {
      const id = rows.ids[i]!, rec = recs.get(id);
      if (!rec) continue;
      const reg = regimeOf.get(id) ?? '?';
      const h = hist.get(reg) ?? new Float64Array(NB + 1); hist.set(reg, h);
      let worst = 0;
      for (let k = 0; k < 1440; k++) {
        const t = dayMs + offs + k * 60_000;
        const pv = satellite.sgp4(rec.sat, (t - rec.epochMs) / 60_000);
        const p = pv ? pv.position : null;
        if (!p || typeof p === 'boolean') continue;
        if (!b.evalOne(i, t, out, 0)) continue;
        const d = Math.hypot(out[0]! - p.x, out[1]! - p.y, out[2]! - p.z);
        h[Math.min(NB, Math.floor(d / BIN))]!++;
        if (d > worst) worst = d;
      }
      perObj.push([id, worst]);
      maxBy.set(reg, Math.max(maxBy.get(reg) ?? 0, worst));
    }
    console.log(`accuracy: B (stored lines) vs SGP4, ${perObj.length} objects x 1440 samples @60 s (offset 37 s), position difference in metres`);
    for (const [reg, h] of [...hist].sort()) {
      const n = h.reduce((s, v) => s + v, 0);
      let c = 0, p99 = 0, p50 = 0;
      for (let k = 0; k <= NB; k++) { c += h[k]!; if (!p50 && c >= n * 0.5) p50 = (k + 1) * BIN; if (c >= n * 0.99) { p99 = (k + 1) * BIN; break; } }
      console.log(`  ${reg.padEnd(6)} samples ${String(n).padStart(9)}  median <= ${(p50 * 1000).toFixed(0)} m  p99 <= ${(p99 * 1000).toFixed(0)} m  max ${(maxBy.get(reg)! * 1000).toFixed(1)} m`);
    }
    perObj.sort((x, y) => y[1] - x[1]);
    console.log('  worst 5: ' + perObj.slice(0, 5).map(([id, e]) => `${id} ${nameOf.get(id)} [${regimeOf.get(id)}] ${(e * 1000).toFixed(1)} m`).join('; '));
  }

  // ---------- browser payload ----------
  for (const f of ['f64', 'f32']) {
    const path = `/tmp/starmap/lines-${day}-${f}.bin`;
    if (!existsSync(path)) continue;
    const raw = readFileSync(path);
    console.log(`payload lines ${f}: raw ${(raw.length / 1e6).toFixed(2)} MB, gzip ${(gzipSync(raw).length / 1e6).toFixed(2)} MB`);
  }
  const jsonPath = args.get('catalog') ?? new URL('../../data/tle-cache.json', import.meta.url).pathname;
  const js = readFileSync(jsonPath);
  console.log(`payload elements JSON (${jsonPath.split('/').pop()}): raw ${(js.length / 1e6).toFixed(2)} MB, gzip ${(gzipSync(js).length / 1e6).toFixed(2)} MB`);
  console.log(`(sink ${sink > 0})`);
  await pool.end();
}
await main();
