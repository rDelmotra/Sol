// ============================================================
// SPIKE — not production. S6 report: prints the S5-vs-S6 tables from the batch meta files and loads the S6 events into
// starmap.conjunction_s6 (one row per event per batch; the S5 tables are not touched).
//   export STARMAP_DB=postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch
//   npx tsx packages/backend/scripts/starmap/forward-report6.ts [--from 2026-10-12] [--to 2026-10-18] [--s5 s5i] [--s6 s6] [--no-db]
// ============================================================
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { parseArgs } from './catalog.js';
import { DB_URL } from './events.js';
import { batchFile, readLines } from './forward-common.js';
import type { FwdEvent } from './forward-lib.js';

const args = parseArgs(process.argv.slice(2));
const FROM = args.get('from') ?? '2026-10-12', TO = args.get('to') ?? '2026-10-18', T5 = args.get('s5') ?? 's5i', T6 = args.get('s6') ?? 's6';
const days: string[] = [];
for (let d = Date.parse(FROM + 'T00:00:00Z'); d <= Date.parse(TO + 'T00:00:00Z'); d += 86_400_000) days.push(new Date(d).toISOString().slice(0, 10));
type M = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const meta = (day: string, tag: string): M | null => (existsSync(batchFile(day, tag, 'meta.json')) ? (JSON.parse(readFileSync(batchFile(day, tag, 'meta.json'), 'utf8')) as M) : null);
const M5 = (x: number) => (x / 1e6).toFixed(1);

const rows5: string[] = [], rows6: string[] = [], rowsSt: string[] = [], rowsEv: string[] = [];
let t5 = 0, t6 = 0, c5 = 0, c6 = 0;
for (const day of days) {
  const a = meta(day, T5), b = meta(day, T6);
  if (a) {
    const c = a.sgp4CallsMeasured, tm = a.timing;
    rows5.push(`| ${day} | ${M5(c.total)} | ${M5(c.grid)} | ${M5(c.formation)} | ${M5(c.refine)} | ${M5(c.pc + c.garbageCheck)} | ${tm.total} | ${tm.grid} | ${tm.formation} | ${tm.refine} | ${tm.pc} | ${a.maxRssMB} | ${a.events.lt5} |`);
    t5 += tm.total; c5 += c.total;
  }
  if (b) {
    const c = b.sgp4CallsMeasured, tm = b.timing;
    rows6.push(`| ${day} | ${M5(c.total)} | ${M5(c.radius)} | ${M5(c.coarse)} | ${M5(c.formation)} | ${M5(c.refine)} | ${tm.total} | ${tm.radius} | ${tm.coarse} | ${tm.formation} | ${tm.refine} | ${b.maxRssMB} | ${b.events.total} |`);
    rowsSt.push(`| ${day} | ${a ? (a.sgp4CallsMeasured.total / c.total).toFixed(1) : '-'} | ${a ? (a.timing.total / tm.total).toFixed(2) : '-'} | ${b.prefilter.objectsWithNoPartner} | ${b.passes.map((p: M) => `${p.pairTests} / ${p.afterGatherRadius} / ${p.afterShellTest} / ${p.afterSegmentTest} / ${p.candidateWindows}`).join(' ; ')} | ${b.grid.runs} | ${b.grid.minima} | ${b.grid.acceptedMinima} |`);
    const e = b.events;
    rowsEv.push(`| ${day} | ${e.total} | ${e.inVolumeBox} | ${e.inVolumeEllipsoid} | ${e.within5km} | ${e.boxOnly} | ${e.within5kmOnly} | ${Object.entries(e.byVolumeId).map(([k, v]) => `${k}:${v}`).join(' ')} | ${b.pcCounts.balanced.gt1e5} / ${b.pcCounts.balanced.gt1e4} |`);
    t6 += tm.total; c6 += c.total;
  }
}
console.log(`\n## S5 (instrumented, tag ${T5}): SGP4 calls in millions, seconds\n| batch | calls | grid | formation | refine | pc+check | wall s | grid s | formation s | refine s | pc s | RSS MB | events <5 km |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n${rows5.join('\n')}`);
console.log(`\n## S6 (tag ${T6})\n| batch | calls | radius | coarse | formation | refine+Pc | wall s | radius s | coarse s | formation s | refine+Pc s | RSS MB | events |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n${rows6.join('\n')}`);
console.log(`\n## reduction and stage counters\n| batch | calls S5/S6 | wall S5/S6 | objects without partner | coarse pair tests / within gather radius / after shell test / after segment test / windows | runs | minima | in volume |\n|---|---|---|---|---|---|---|---|\n${rowsSt.join('\n')}`);
console.log(`\ntotals: S5 ${M5(c5)} M calls ${t5.toFixed(0)} s; S6 ${M5(c6)} M calls ${t6.toFixed(0)} s; ratio calls ${(c5 / c6).toFixed(2)}, wall ${(t5 / t6).toFixed(2)}`);
console.log(`\n## S6 events by volume\n| batch | events | in box | in ellipsoid | within 5 km | box only | 5 km only | by primary volume id | Pc>1e-5 / >1e-4 (balanced) |\n|---|---|---|---|---|---|---|---|---|\n${rowsEv.join('\n')}`);

async function load(): Promise<void> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DROP TABLE IF EXISTS starmap.conjunction_s6;
      CREATE TABLE starmap.conjunction_s6 (
        id bigserial PRIMARY KEY, batch_time timestamptz NOT NULL, norad_a int NOT NULL, norad_b int NOT NULL, tca timestamptz NOT NULL,
        miss_km real NOT NULL, vrel_kms real NOT NULL, ric_r_km real, ric_i_km real, ric_c_km real, vol_a smallint, vol_b smallint,
        b_in_vol_a boolean, a_in_vol_b boolean, within_5km boolean, age_a_d real, age_b_d real, hbr_m real,
        pc_balanced float8, pc_conservative float8, pc_max float8, label text, man_a boolean, man_b boolean);
      CREATE INDEX conjunction_s6_pair_idx ON starmap.conjunction_s6 (norad_a, norad_b);
      CREATE INDEX conjunction_s6_tca_idx ON starmap.conjunction_s6 (tca);
      CREATE INDEX conjunction_s6_pc_idx ON starmap.conjunction_s6 (pc_balanced DESC);`);
    let n = 0;
    for (const day of days) {
      if (!existsSync(batchFile(day, T6))) continue;
      const m = meta(day, T6)!;
      const ev = readLines(batchFile(day, T6)).map((l) => JSON.parse(l) as FwdEvent);
      for (let p = 0; p < ev.length; p += 5000) {
        const s = ev.slice(p, p + 5000);
        await c.query(`INSERT INTO starmap.conjunction_s6 (batch_time, norad_a, norad_b, tca, miss_km, vrel_kms, ric_r_km, ric_i_km, ric_c_km, vol_a, vol_b, b_in_vol_a, a_in_vol_b, within_5km, age_a_d, age_b_d, hbr_m, pc_balanced, pc_conservative, pc_max, label, man_a, man_b)
          SELECT $1::timestamptz, * FROM unnest($2::int[], $3::int[], $4::timestamptz[], $5::real[], $6::real[], $7::real[], $8::real[], $9::real[], $10::smallint[], $11::smallint[], $12::boolean[], $13::boolean[], $14::boolean[], $15::real[], $16::real[], $17::real[], $18::float8[], $19::float8[], $20::float8[], $21::text[], $22::boolean[], $23::boolean[])`,
        [m.batchTime, s.map((e) => e.a), s.map((e) => e.b), s.map((e) => new Date(e.tca).toISOString()), s.map((e) => e.miss), s.map((e) => e.vrel), s.map((e) => e.ric[0]), s.map((e) => e.ric[1]), s.map((e) => e.ric[2]),
          s.map((e) => e.vol!.va), s.map((e) => e.vol!.vb), s.map((e) => e.vol!.inA), s.map((e) => e.vol!.inB), s.map((e) => e.vol!.in5), s.map((e) => e.ageA), s.map((e) => e.ageB), s.map((e) => e.hbr * 1000),
          s.map((e) => e.pcBal), s.map((e) => e.pcCons), s.map((e) => e.pcMax), s.map((e) => e.cat), s.map((e) => e.manA), s.map((e) => e.manB)]);
        n += s.length;
      }
    }
    await c.query('COMMIT');
    const sz = (await c.query("SELECT pg_total_relation_size('starmap.conjunction_s6') AS a")).rows[0] as { a: string };
    console.log(`\n## database: starmap.conjunction_s6 ${n} rows (${(Number(sz.a) / 1e6).toFixed(1)} MB)`);
    const t = Date.now();
    const r = await c.query('SELECT count(*)::int AS n FROM starmap.conjunction_s6 WHERE norad_a = 25544 OR norad_b = 25544');
    console.log(`query: all S6 events involving the ISS: ${r.rows[0].n} rows in ${Date.now() - t} ms`);
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { await c.end(); }
}
if (!args.has('no-db')) await load();
