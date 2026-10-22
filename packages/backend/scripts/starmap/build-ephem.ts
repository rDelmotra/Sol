// ============================================================
// SPIKE — not production.
//
// Build Chebyshev "day lines" for a whole catalog for one UTC day.
//
//   npx tsx packages/backend/scripts/starmap/build-ephem.ts --catalog path.json --day 2026-10-20 \
//     [--tol 0.1] [--workers N] [--precision f64|f32] [--out file.bin] [--db] [--limit N]
//
// --out file: records of [u32 norad][u32 len][bytes].
// --db: inserts starmap.ephem_day (the chosen precision) AND starmap.elset_day (the OMM of every
//       object that got a line) so the benchmark fetches both paths from the same database.
// ============================================================
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as satellite from 'satellite.js';
import pg from 'pg';
import { fitDayLine, type Precision } from './ephem.js';
import { makeProp, windowInCap } from './runs.js';
import { loadCatalog, parseArgs } from './catalog.js';

import { DB_URL, DDL } from './ephem-db.js';
const CHUNK = 100;
interface Job { base: number; omms: Array<Record<string, unknown>>; dayStartMs: number; tolKm: number }
interface ObjRes { i: number; f64?: Uint8Array; f32?: Uint8Array; nseg?: number; deg?: number; err?: number; fail?: string }
interface Done { res: ObjRes[] }

if (!isMainThread) {
  parentPort!.on('message', (j: Job) => {
    const res: ObjRes[] = [];
    j.omms.forEach((omm, k) => {
      const i = j.base + k;
      const p = makeProp(omm);
      if (!p) return res.push({ i, fail: 'bad-elements' });
      if (!windowInCap(p, j.dayStartMs, j.dayStartMs + 86_400_000)) return res.push({ i, fail: 'outside-60d-epoch-cap' });
      const fn = (t: number): [number, number, number] | null => {
        const pv = satellite.sgp4(p.satrec, (t - p.epochMs) / 60_000);
        const pos = pv ? pv.position : null;
        if (!pos || typeof pos === 'boolean' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null;
        return [pos.x, pos.y, pos.z];
      };
      const a = fitDayLine(fn, j.dayStartMs, { tolKm: j.tolKm, precision: 'f64' });
      if ('fail' in a) return res.push({ i, fail: a.fail + (a.detail ? ` ${a.detail}` : '') });
      const b = fitDayLine(fn, j.dayStartMs, { tolKm: j.tolKm, precision: 'f32' });
      if ('fail' in b) return res.push({ i, fail: 'f32-' + b.fail });
      res.push({ i, f64: a.buf, f32: b.buf, nseg: a.nseg, deg: a.deg, err: Math.max(a.maxErrKm, b.maxErrKm) });
    });
    parentPort!.postMessage({ res } satisfies Done);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const catPath = args.get('catalog');
  const day = args.get('day') ?? '2026-10-20';
  const tolKm = Number(args.get('tol') ?? 0.1);
  const nWorkers = Number(args.get('workers') ?? Math.max(1, availableParallelism() - 1));
  const precision = (args.get('precision') ?? 'f64') as Precision;
  const limit = Number(args.get('limit') ?? 0);
  const dayStartMs = Date.parse(day + 'T00:00:00Z');
  let cat = loadCatalog(catPath);
  if (limit) cat = cat.slice(0, limit);
  const t0 = Date.now();

  const results: ObjRes[] = [];
  const workers = Array.from({ length: nWorkers }, () => new Worker(fileURLToPath(new URL('./ephem-worker-boot.mjs', import.meta.url))));
  let next = 0;
  const feed = (w: Worker): boolean => {
    if (next >= cat.length) return false;
    const base = next; next = Math.min(cat.length, next + CHUNK);
    w.postMessage({ base, omms: cat.slice(base, next).map((o) => o.omm), dayStartMs, tolKm } satisfies Job);
    return true;
  };
  await new Promise<void>((resolve, reject) => {
    let active = 0;
    for (const w of workers) {
      w.on('error', reject);
      w.on('message', (d: Done) => { results.push(...d.res); if (!feed(w) && --active === 0) resolve(); });
      if (feed(w)) active++;
    }
    if (active === 0) resolve();
  });
  await Promise.all(workers.map((w) => w.terminate()));
  const wall = (Date.now() - t0) / 1000;

  const ok = results.filter((r) => r.f64 && r.f32).sort((a, b) => a.i - b.i);
  const fenced = results.filter((r) => r.fail);
  const byReg = new Map<string, { n: number; b64: number; b32: number; deg: number; nseg: number }>();
  let b64 = 0, b32 = 0, worstErr = 0;
  for (const r of ok) {
    const reg = cat[r.i]!.regime;
    const e = byReg.get(reg) ?? { n: 0, b64: 0, b32: 0, deg: 0, nseg: 0 };
    e.n++; e.b64 += r.f64!.length; e.b32 += r.f32!.length; e.deg += r.deg!; e.nseg += r.nseg!;
    byReg.set(reg, e);
    b64 += r.f64!.length; b32 += r.f32!.length; worstErr = Math.max(worstErr, r.err!);
  }
  console.log(`day ${day} tol ${tolKm} km  catalog ${cat.length}  lines ${ok.length}  workers ${nWorkers}  wall ${wall.toFixed(1)} s`);
  console.log(`total bytes: f64 ${(b64 / 1e6).toFixed(2)} MB (${(b64 / ok.length).toFixed(0)} B/obj)  f32 ${(b32 / 1e6).toFixed(2)} MB (${(b32 / ok.length).toFixed(0)} B/obj)  worst fit err ${worstErr.toFixed(4)} km`);
  console.log('per regime: n, f64 B/obj, f32 B/obj, mean deg, mean nseg');
  for (const [reg, e] of [...byReg].sort()) console.log(`  ${reg.padEnd(6)} ${String(e.n).padStart(6)}  ${(e.b64 / e.n).toFixed(0).padStart(6)}  ${(e.b32 / e.n).toFixed(0).padStart(6)}  ${(e.deg / e.n).toFixed(1)}  ${(e.nseg / e.n).toFixed(1)}`);
  const reasons = new Map<string, number>();
  for (const f of fenced) { const k = f.fail!.split(' ')[0]!; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
  console.log(`fenced: ${fenced.length} ${JSON.stringify(Object.fromEntries(reasons))}`);
  for (const f of fenced.slice(0, 15)) console.log(`  ${cat[f.i]!.noradId} ${cat[f.i]!.name} [${cat[f.i]!.regime}] ${f.fail}`);
  const big = [...ok].sort((a, b) => b.f64!.length - a.f64!.length).slice(0, 5);
  console.log('largest lines: ' + big.map((r) => `${cat[r.i]!.noradId} ${cat[r.i]!.name} ${r.f64!.length}B deg${r.deg} nseg${r.nseg}`).join('; '));

  const pick = (r: ObjRes): Uint8Array => (precision === 'f32' ? r.f32! : r.f64!);
  const outPath = args.get('out');
  if (outPath) {
    const parts: Buffer[] = [];
    for (const r of ok) { const h = Buffer.alloc(8); h.writeUInt32LE(cat[r.i]!.noradId, 0); h.writeUInt32LE(pick(r).length, 4); parts.push(h, Buffer.from(pick(r))); }
    writeFileSync(outPath, Buffer.concat(parts));
    console.log(`wrote ${outPath} (${precision})`);
  }
  if (args.has('db')) {
    const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
    await pool.query(DDL);
    await pool.query('DELETE FROM starmap.ephem_day WHERE day=$1', [day]);
    await pool.query('DELETE FROM starmap.elset_day WHERE day=$1', [day]);
    const ts = Date.now();
    for (let s = 0; s < ok.length; s += 500) {
      const part = ok.slice(s, s + 500);
      const ids = part.map((r) => cat[r.i]!.noradId);
      await pool.query(
        `INSERT INTO starmap.ephem_day (norad_id, day, elset_epoch, tol_km, line)
         SELECT * FROM unnest($1::int[], $2::date[], $3::timestamptz[], $4::real[], $5::bytea[])`,
        [ids, part.map(() => day), part.map((r) => String(cat[r.i]!.omm.EPOCH)), part.map(() => tolKm), part.map((r) => Buffer.from(pick(r)))],
      );
      await pool.query(
        `INSERT INTO starmap.elset_day (norad_id, day, omm) SELECT * FROM unnest($1::int[], $2::date[], $3::jsonb[])`,
        [ids, part.map(() => day), part.map((r) => JSON.stringify(cat[r.i]!.omm))],
      );
    }
    await pool.query('ANALYZE starmap.ephem_day'); await pool.query('ANALYZE starmap.elset_day');
    const sz = await pool.query(
      `SELECT pg_total_relation_size('starmap.ephem_day') e, pg_relation_size('starmap.ephem_day') eh,
              pg_total_relation_size('starmap.elset_day') s, (SELECT count(*) FROM starmap.ephem_day) n`);
    const q = sz.rows[0];
    console.log(`db insert ${(Date.now() - ts) / 1000} s; ephem_day total ${(q.e / 1e6).toFixed(1)} MB (heap ${(q.eh / 1e6).toFixed(1)} MB, ${q.n} rows total); elset_day total ${(q.s / 1e6).toFixed(1)} MB`);
    await pool.end();
  }
}
if (isMainThread) await main();
