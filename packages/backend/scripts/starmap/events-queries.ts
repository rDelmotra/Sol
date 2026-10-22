// ============================================================
// SPIKE — not production. Q-E1..Q-E4 over starmap.event (median of 5) + verification against brute-force SGP4.
//   npx tsx packages/backend/scripts/starmap/events-queries.ts [q|verify|report]
// ============================================================
import pg from 'pg';
import * as satellite from 'satellite.js';
import { DB_URL, REGIONS, REGION_CODES, DAY_MS, contiguousDays, dayStartMs, loadDayCatalog, regionContains, type CatFull } from './events.js';
import { makeProp, type Prop } from './runs.js';

const mode = process.argv[2] ?? 'q';
const client = new pg.Client({ connectionString: DB_URL });
await client.connect();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function timed<T>(fn: () => Promise<T>, n = 5): Promise<{ ms: number; all: number[]; out: T }> {
  const all: number[] = [];
  let out!: T;
  for (let i = 0; i < n; i++) { const t = performance.now(); out = await fn(); all.push(performance.now() - t); }
  return { ms: median(all), all, out };
}
/** Days actually derived into the table (the run was cut short at the lead's request). */
const days = ((await client.query('SELECT DISTINCT day::text AS d FROM starmap.event ORDER BY 1')).rows as Array<{ d: string }>).map((r) => r.d).filter((d) => contiguousDays().includes(d));
const lastDay = days.at(-1)!;

// ---- Q-E1: ISS passes over India ----
async function qE1(): Promise<Array<{ day: string; a: number; b: number }>> {
  const r = await client.query(`SELECT day::text AS day, payload->>'IN' AS p FROM starmap.event WHERE kind = 'region.pass' AND subjects @> ARRAY[25544] AND payload ? 'IN' ORDER BY day`);
  const out: Array<{ day: string; a: number; b: number }> = [];
  for (const row of r.rows as Array<{ day: string; p: string }>) {
    for (const seg of row.p.split(';')) { const [a, b] = seg.split('-').map(Number); out.push({ day: row.day, a: dayStartMs(row.day) + a! * 1000, b: dayStartMs(row.day) + b! * 1000 }); }
  }
  return out;
}
// the same answer unpacked inside SQL
const Q_E1_SQL = `SELECT day, (string_to_array(seg, '-'))[1]::int AS a, (string_to_array(seg, '-'))[2]::int AS b
  FROM starmap.event, regexp_split_to_table(payload->>'IN', ';') AS seg
  WHERE kind = 'region.pass' AND subjects @> ARRAY[25544] AND payload ? 'IN' ORDER BY day, a`;

if (mode === 'q') {
  const e1 = await timed(qE1);
  const e1s = await timed(() => client.query(Q_E1_SQL));
  console.log(`Q-E1 ISS passes over India, ${days.length} days: ${e1.out.length} passes, median ${e1.ms.toFixed(1)} ms (fetch+unpack in JS; runs ${e1.all.map((x) => x.toFixed(1)).join('/')}); pure SQL unpack ${e1s.ms.toFixed(1)} ms (${e1s.out.rowCount} rows)`);

  // Q-E2: pick an object with several approaches
  const top = await client.query(`SELECT s, count(*)::int AS n FROM starmap.event, unnest(subjects) s WHERE kind = 'close.approach' GROUP BY s ORDER BY n DESC LIMIT 6000`);
  const names = new Map(loadDayCatalog(lastDay).map((o) => [o.noradId, o.name]));
  const total = Number((await client.query(`SELECT count(*) FROM starmap.event WHERE kind='close.approach'`)).rows[0].count);
  const pick = (top.rows as Array<{ s: number; n: number }>).filter((r) => names.has(r.s) && !/STARLINK|ONEWEB/.test(names.get(r.s)!)).sort((x, y) => Math.abs(x.n - 100) - Math.abs(y.n - 100))[0]!; // a non-constellation object with ~100 approaches
  console.log(`close.approach rows total ${total}; top subject ${top.rows[0].s} (${names.get(top.rows[0].s)}) ${top.rows[0].n}; picked ${pick.s} ${names.get(pick.s)} with ${pick.n}`);
  const e2 = await timed(() => client.query(`SELECT subjects, t_start, payload FROM starmap.event WHERE kind='close.approach' AND subjects @> ARRAY[$1::int] ORDER BY t_start`, [pick.s]));
  console.log(`Q-E2 close approaches involving ${pick.s} (${names.get(pick.s)}): ${e2.out.rowCount} events, median ${e2.ms.toFixed(1)} ms (${e2.all.map((x) => x.toFixed(1)).join('/')}); closest: ${JSON.stringify((e2.out.rows as Array<{ subjects: number[]; t_start: Date; payload: { d: number } }>).sort((a, b) => a.payload.d - b.payload.d).slice(0, 3).map((r) => [r.subjects.join('-'), r.t_start.toISOString(), r.payload.d]))}`);
  const e2b = await timed(() => client.query(`SELECT count(*) FROM starmap.event WHERE kind='close.approach' AND subjects @> ARRAY[$1::int] AND day >= $2::date - 6`, [pick.s, lastDay]));
  console.log(`   (last 7 days only: ${e2b.out.rows[0].count}, ${e2b.ms.toFixed(1)} ms)`);

  // Q-E3: Starlink maneuvers, last 7 days
  const e3 = await timed(() => client.query(`SELECT subjects[1] AS id, t_end, payload FROM starmap.event WHERE kind='elements.jump' AND day >= $1::date - 6 AND payload->>'name' LIKE 'STARLINK%'`, [lastDay]));
  const dirs: Record<string, number> = {};
  for (const r of e3.out.rows as Array<{ payload: { dir: string } }>) dirs[r.payload.dir] = (dirs[r.payload.dir] ?? 0) + 1;
  const jumpTotal = Number((await client.query(`SELECT count(*) FROM starmap.event WHERE kind='elements.jump' AND day >= $1::date - 6`, [lastDay])).rows[0].count);
  const distinctSl = new Set((e3.out.rows as Array<{ id: number }>).map((r) => r.id)).size;
  console.log(`Q-E3 Starlink elements.jump in last 7 days: ${e3.out.rowCount} events on ${distinctSl} satellites (${JSON.stringify(dirs)}), of ${jumpTotal} jumps all objects; median ${e3.ms.toFixed(1)} ms (${e3.all.map((x) => x.toFixed(1)).join('/')})`);

  // Q-E4: disappeared and were they decays
  const e4 = await timed(() => client.query(`SELECT payload->>'cls' AS cls, payload->>'satcat' AS truth, count(*)::int AS n FROM starmap.event WHERE kind='object.disappeared' GROUP BY 1, 2 ORDER BY 3 DESC`));
  const e4b = await timed(() => client.query(`SELECT count(*)::int AS n, count(a.id)::int AS reappeared FROM starmap.event d LEFT JOIN starmap.event a ON a.kind='object.appeared' AND a.subjects = d.subjects AND a.day > d.day WHERE d.kind='object.disappeared'`));
  console.log(`Q-E4 disappeared: ${e4b.out.rows[0].n} events, ${e4b.out.rows[0].reappeared} later reappeared in the window; median ${e4.ms.toFixed(1)} ms group-by / ${e4b.ms.toFixed(1)} ms with reappear join`);
  console.table(e4.out.rows);
}

// ---- verification ----
function polyIssBrute(): Array<{ day: string; a: number; b: number }> {
  const india = REGIONS[0]!;
  const out: Array<{ day: string; a: number; b: number }> = [];
  for (const day of days) {
    const iss = loadDayCatalog(day).find((o) => o.noradId === 25544);
    if (!iss) continue;
    const p = makeProp(iss.omm)!;
    const t0 = dayStartMs(day);
    let inside = false, start = 0, last = 0;
    for (let t = t0; t < t0 + DAY_MS; t += 5000) {
      const pv = satellite.sgp4(p.satrec, (t - p.epochMs) / 60_000);
      const r = pv && typeof pv.position !== 'boolean' ? pv.position : null;
      let now = false;
      if (r) {
        const g = satellite.eciToGeodetic(r, satellite.gstime(new Date(t)));
        now = regionContains(india, satellite.degreesLat(g.latitude), satellite.degreesLong(g.longitude));
      }
      if (now && !inside) start = t;
      if (!now && inside) out.push({ day, a: start, b: last });
      if (now) last = t;
      inside = now;
    }
    if (inside) out.push({ day, a: start, b: t0 + DAY_MS - 5000 });
  }
  return out;
}

if (mode === 'verify') {
  const stored = await qE1();
  const t = Date.now();
  const brute = polyIssBrute();
  console.log(`brute force ISS over India, ${days.length} days at 5 s: ${brute.length} passes in ${((Date.now() - t) / 1000).toFixed(1)} s; stored ${stored.length}`);
  let matched = 0, maxA = 0, maxB = 0;
  const unmatchedBrute: string[] = [];
  const used = new Set<number>();
  for (const b of brute) {
    const k = stored.findIndex((s, i) => !used.has(i) && Math.abs(s.a - b.a) <= 20_000 && Math.abs(s.b - b.b) <= 20_000);
    if (k < 0) { unmatchedBrute.push(`${new Date(b.a).toISOString()}..${new Date(b.b).toISOString()} (${((b.b - b.a) / 1000).toFixed(0)} s)`); continue; }
    used.add(k); matched++;
    maxA = Math.max(maxA, Math.abs(stored[k]!.a - b.a)); maxB = Math.max(maxB, Math.abs(stored[k]!.b - b.b));
  }
  console.log(`matched ${matched}/${brute.length} within 20 s; max |start diff| ${(maxA / 1000).toFixed(1)} s, max |end diff| ${(maxB / 1000).toFixed(1)} s; stored-but-not-brute ${stored.length - used.size}; unmatched brute: ${unmatchedBrute.slice(0, 6).join(' | ')}`);
  const extra = stored.filter((_, i) => !used.has(i)).slice(0, 6).map((s) => `${new Date(s.a).toISOString()}..${new Date(s.b).toISOString()} (${((s.b - s.a) / 1000).toFixed(0)} s)`);
  if (extra.length) console.log('stored extra:', extra.join(' | '));

  // spot-check 5 close approaches by exact recomputation (0.1 s scan +- 30 s, then golden section)
  const rows = (await client.query(`SELECT day::text AS day, subjects, extract(epoch from t_start)::float8*1000 AS t, payload FROM starmap.event WHERE kind='close.approach' ORDER BY md5(id::text) LIMIT 5`)).rows as Array<{ day: string; subjects: number[]; t: number; payload: { d: number; v: number } }>;
  for (const r of rows) {
    const cat = new Map(loadDayCatalog(r.day).filter((o) => r.subjects.includes(o.noradId)).map((o) => [o.noradId, o]));
    const [A, B] = r.subjects.map((id) => makeProp(cat.get(id)!.omm)!) as [Prop, Prop];
    const dist = (tm: number) => {
      const pa = satellite.sgp4(A.satrec, (tm - A.epochMs) / 60_000), pb = satellite.sgp4(B.satrec, (tm - B.epochMs) / 60_000);
      if (!pa || !pb || typeof pa.position === 'boolean' || typeof pb.position === 'boolean') return Infinity;
      return Math.hypot(pa.position.x - pb.position.x, pa.position.y - pb.position.y, pa.position.z - pb.position.z);
    };
    let best = Infinity, bt = r.t;
    for (let q = -30000; q <= 30000; q += 100) { const d = dist(r.t + q); if (d < best) { best = d; bt = r.t + q; } }
    let l = bt - 100, h = bt + 100;
    const G = 0.6180339887498949;
    for (let i = 0; i < 40; i++) { const x1 = h - G * (h - l), x2 = l + G * (h - l); if (dist(x1) < dist(x2)) h = x2; else l = x1; }
    const d = dist((l + h) / 2);
    console.log(`spot-check ${r.subjects.join('-')} ${r.day}: stored ${r.payload.d} km @ ${new Date(r.t).toISOString()}; exact ${d.toFixed(3)} km @ ${new Date((l + h) / 2).toISOString()}; |dd| ${Math.abs(d - r.payload.d).toFixed(3)} km, |dt| ${(Math.abs((l + h) / 2 - r.t) / 1000).toFixed(2)} s`);
  }
}

if (mode === 'report') {
  const r = await client.query(`SELECT stats FROM starmap.event_stats ORDER BY day`);
  console.log('day | diff s (app/dis/jump) | region s | ca grid s | form s | refine s | total s | rows app/dis/jump/ca/form/region | MB');
  for (const { stats: s } of r.rows as Array<{ stats: any }>) {
    const t = s.timing, k = s.rows;
    console.log([s.day, t.diff ? `${t.diff.appeared}/${t.diff.disappeared}/${t.diff.jump}` : '-', t.region, t.ca?.grid, t.ca?.formation, t.ca?.refine, t.total, [k['object.appeared'], k['object.disappeared'], k['elements.jump'], k['close.approach'], k['close.formation'], k['region.pass']].join('/'), s.tableDeltaMB].join(' | '));
  }
}
void REGION_CODES;
await client.end();
