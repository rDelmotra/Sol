// ============================================================
// SPIKE — not production. Independent checks of the derived events against brute-force SGP4.
//   npx tsx packages/backend/scripts/starmap/verify-events.ts regions [--objects 400] [--days 3] [--step 2]
//   npx tsx packages/backend/scripts/starmap/verify-events.ts ca-recall <day> <startHour> <hours>     (needs derive-day.ts --ca-full for that day)
//   npx tsx packages/backend/scripts/starmap/verify-events.ts jumps
// 'regions': random sample of objects, every region, SGP4 at --step seconds (own loop, satellite.js eciToGeodetic: NOT the
//            worker's fast path) vs the stored region.pass rows; every brute-force pass must be inside a stored pass (+-20 s).
// 'ca-recall': three objects vs the whole catalog, 2 s steps, golden-section refine, vs the full < 5 km set.
// 'jumps': five stored jumps recomputed by hand from the raw element sets.
// ============================================================
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import * as satellite from 'satellite.js';
import { parseArgs, rng } from './catalog.js';
import { makeProp, type Prop } from './runs.js';
import { DB_URL, EVENTS_DIR, REGIONS, REGION_CODES, DAY_MS, contiguousDays, dayStartMs, loadDayCatalog, regionContains, semiMajorKm, epochMsOf, type CatFull } from './events.js';

const mode = process.argv[2] ?? 'regions';
const args = parseArgs(process.argv.slice(3));
const client = new pg.Client({ connectionString: DB_URL });
await client.connect();

function geodetic(p: Prop, tMs: number): { lat: number; lon: number; rad: number } | null {
  const pv = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = pv ? pv.position : null;
  if (!r || typeof r === 'boolean' || !Number.isFinite(r.x)) return null;
  const g = satellite.eciToGeodetic(r, satellite.gstime(new Date(tMs)));
  return { lat: satellite.degreesLat(g.latitude), lon: satellite.degreesLong(g.longitude), rad: Math.hypot(r.x, r.y, r.z) };
}

if (mode === 'regions') {
  const nObj = Number(args.get('objects') ?? 400), nDays = Number(args.get('days') ?? 3), step = Number(args.get('step') ?? 2) * 1000;
  const all = contiguousDays();
  const rand = rng(20261023);
  const days = Array.from({ length: nDays }, () => all[Math.floor(rand() * all.length)]!).filter((d, i, a) => a.indexOf(d) === i);
  const tot = { brute: 0, found: 0, objects: 0, maxStart: 0, maxEnd: 0 };
  const byReg: Record<string, [number, number]> = {};
  const missed: string[] = [], big: string[] = [];
  const raw = new Map<string, Array<[number, number]>>();
  let extra = 0, storedN = 0;
  for (const day of days) {
    const cat = loadDayCatalog(day);
    const t0 = dayStartMs(day);
    // stratified random sample: all regimes represented
    const pools: Record<string, CatFull[]> = {};
    for (const o of cat) (pools[o.regime] ??= []).push(o);
    const pick: CatFull[] = [];
    for (const [reg, list] of Object.entries(pools)) {
      const want = reg === 'LEO' ? Math.round(nObj * 0.6) : Math.round(nObj * 0.1);
      for (let k = 0; k < want && list.length; k++) pick.push(list[Math.floor(rand() * list.length)]!);
    }
    const ids = [...new Set(pick.map((o) => o.noradId))];
    const stored = (await client.query(`SELECT subjects[1] AS id, payload FROM starmap.event WHERE kind='region.pass' AND day=$1 AND subjects[1] = ANY($2::int[])`, [day, ids])).rows as Array<{ id: number; payload: Record<string, string> }>;
    const sm = new Map<string, Array<[number, number]>>();
    for (const r of stored) for (const [code, v] of Object.entries(r.payload)) for (const seg of v.split(';')) {
      const [a, b] = seg.split('-').map(Number);
      const k = `${r.id}|${code}`;
      (sm.get(k) ?? sm.set(k, []).get(k)!).push([t0 + a! * 1000, t0 + b! * 1000]);
      storedN++;
    }
    for (const [k, v] of sm) raw.set(k, v.map((x) => [x[0], x[1]] as [number, number]));
    // stored passes split by a <= 2 s gap are one pass to a 2 s brute force (a 1 s notch at a polygon vertex is below its resolution)
    for (const [k, segs] of sm) {
      segs.sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const sg of segs) { const l = merged[merged.length - 1]; if (l && sg[0] - l[1] <= 2000) l[1] = Math.max(l[1], sg[1]); else merged.push([sg[0], sg[1]]); }
      sm.set(k, merged);
    }
    let fencedN = 0;
    for (const id of ids) {
      const o = cat.find((c) => c.noradId === id)!;
      const p = makeProp(o.omm);
      if (!p) continue;
      let bad = false;
      for (const tm of [t0, t0 + DAY_MS / 2, t0 + DAY_MS]) { const g = geodetic(p, tm); if (!g || g.rad < 6340 || g.rad > 1e6) bad = true; }
      if (bad) { fencedN++; continue; }
      tot.objects++;
      const open: number[] = new Array(REGIONS.length).fill(-1), last: number[] = new Array(REGIONS.length).fill(0);
      const brutePasses: Array<[number, number, number]> = [];
      for (let t = t0; t <= t0 + DAY_MS; t += step) {
        const g = geodetic(p, t);
        for (let r = 0; r < REGIONS.length; r++) {
          const inside = g !== null && regionContains(REGIONS[r]!, g.lat, g.lon);
          if (inside) { if (open[r]! < 0) open[r] = t; last[r] = t; }
          else if (open[r]! >= 0) { brutePasses.push([r, open[r]!, last[r]!]); open[r] = -1; }
        }
      }
      for (let r = 0; r < REGIONS.length; r++) if (open[r]! >= 0) brutePasses.push([r, open[r]!, last[r]!]);
      for (const [r, a, b] of brutePasses) {
        const code = REGION_CODES[r]!;
        (byReg[code] ??= [0, 0])[0]++; tot.brute++;
        const segs = sm.get(`${id}|${code}`) ?? [];
        // brute pass (first/last in-sample) lies inside a stored pass, allowing 20 s at each end
        const hit = segs.find(([sa, sb]) => a >= sa - 20_000 && b <= sb + 20_000);
        if (hit && (Math.abs(a - hit[0]) > 60_000 || Math.abs(b - hit[1]) > 60_000)) big.push(`${day} ${id} ${o.name} (${o.regime}) ${code}: brute ${(a - t0) / 1000}..${(b - t0) / 1000} s, merged stored ${(hit[0] - t0) / 1000}..${(hit[1] - t0) / 1000} s, raw stored pieces inside: ${(raw.get(`${id}|${code}`) ?? []).filter(([x, y]) => x >= hit[0] && y <= hit[1]).length}, brute passes inside same stored: ${brutePasses.filter(([r2, a2, b2]) => REGION_CODES[r2] === code && a2 >= hit[0] - 20_000 && b2 <= hit[1] + 20_000).length}`);
        if (hit) { tot.found++; byReg[code]![1]++; tot.maxStart = Math.max(tot.maxStart, Math.abs(a - hit[0])); tot.maxEnd = Math.max(tot.maxEnd, Math.abs(b - hit[1])); }
        else missed.push(`${day} ${id} ${o.name} ${code} brute ${new Date(a).toISOString().slice(11, 19)}..${new Date(b).toISOString().slice(11, 19)} stored ${JSON.stringify(segs.map(([x, y]) => [(x - t0) / 1000, (y - t0) / 1000]))}`);
      }
      // stored passes with no brute-force pass overlapping them (graze shorter than the brute step is fine)
      for (const [k, segs] of sm) {
        if (!k.startsWith(id + '|')) continue;
        const code = k.split('|')[1]!;
        for (const [sa, sb] of segs) if (!brutePasses.some(([r, a, b]) => REGION_CODES[r] === code && a <= sb + 20_000 && b >= sa - 20_000)) extra++;
      }
    }
    console.log(`day ${day}: sample ${ids.length} objects (${fencedN} fenced), stored passes read ${storedN}`);
  }
  console.log(`REGIONS sample: ${tot.objects} object-days, brute-force passes ${tot.brute} (step ${step / 1000}s), found in stored rows ${tot.found} => recall ${((100 * tot.found) / Math.max(1, tot.brute)).toFixed(3)}%; max |start diff| ${(tot.maxStart / 1000).toFixed(1)} s, max |end diff| ${(tot.maxEnd / 1000).toFixed(1)} s; stored passes with no brute pass nearby ${extra}`);
  console.log('per region [brute, found]:', JSON.stringify(byReg));
  if (big.length) console.log('LARGE START/END DIFFERENCES:\n' + big.slice(0, 30).join('\n'));
  if (missed.length) console.log('MISSED:\n' + missed.slice(0, 20).join('\n'));
}

if (mode === 'ca-recall') {
  const day = process.argv[3]!, h0 = Number(process.argv[4] ?? 0), hours = Number(process.argv[5] ?? 3);
  const cat = loadDayCatalog(day);
  const props: Array<Prop | null> = cat.map((o) => makeProp(o.omm));
  // targets: the ISS, the busiest objects of that day in the full < 5 km set, and some random ones
  const fullAll = gunzipSync(readFileSync(EVENTS_DIR + `ca-full-${day}.jsonl.gz`)).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as [number, number, number, number, number, string]);
  const cnt = new Map<number, number>();
  for (const r of fullAll) { cnt.set(r[0], (cnt.get(r[0]) ?? 0) + 1); cnt.set(r[1], (cnt.get(r[1]) ?? 0) + 1); }
  const busiest = [...cnt].sort((x, y) => y[1] - x[1]).slice(0, Number(args.get('busy') ?? 30)).map((x) => x[0]);
  const rnd = rng(77);
  const randoms = Array.from({ length: Number(args.get('random') ?? 12) }, () => cat[Math.floor(rnd() * cat.length)]!.noradId);
  const idx = new Map(cat.map((o, i) => [o.noradId, i]));
  const targets = [...new Set([25544, ...busiest, ...randoms])].map((id) => idx.get(id)!).filter((i) => i !== undefined && props[i]);
  const formPairs = new Set(((await client.query(`SELECT subjects FROM starmap.event WHERE kind='close.formation' AND day=$1`, [day])).rows as Array<{ subjects: number[] }>).map((r) => r.subjects.join('-')));
  const t0 = dayStartMs(day) + h0 * 3_600_000, t1 = t0 + hours * 3_600_000;
  const DT = 2000;
  const full = fullAll;
  const N = cat.length;
  const nSteps = Math.round((t1 - t0) / DT);
  const prevD = targets.map(() => new Float64Array(N)), prev2 = targets.map(() => new Float64Array(N));
  const pos = new Float64Array(N * 3);
  const found: Array<{ ti: number; j: number; d: number; t: number; v: number }> = [];
  const dist = (a: Prop, b: Prop, tm: number) => {
    const pa = satellite.sgp4(a.satrec, (tm - a.epochMs) / 60_000), pb = satellite.sgp4(b.satrec, (tm - b.epochMs) / 60_000);
    if (!pa || !pb || typeof pa.position === 'boolean' || typeof pb.position === 'boolean') return Infinity;
    return Math.hypot(pa.position.x - pb.position.x, pa.position.y - pb.position.y, pa.position.z - pb.position.z);
  };
  const GR = 0.6180339887498949;
  const grp = new Map<string, number[]>();
  cat.forEach((o, i) => { const k = [o.omm.EPOCH, o.omm.MEAN_MOTION, o.omm.ECCENTRICITY, o.omm.INCLINATION, o.omm.RA_OF_ASC_NODE, o.omm.MEAN_ANOMALY].join('|'); (grp.get(k) ?? grp.set(k, []).get(k)!).push(i); });
  const identical = (i: number, j: number) => { const o = cat[i]!, q = cat[j]!; return [o.omm.EPOCH, o.omm.MEAN_MOTION, o.omm.ECCENTRICITY, o.omm.INCLINATION, o.omm.RA_OF_ASC_NODE, o.omm.ARG_OF_PERICENTER, o.omm.MEAN_ANOMALY, o.omm.BSTAR].join('|') === [q.omm.EPOCH, q.omm.MEAN_MOTION, q.omm.ECCENTRICITY, q.omm.INCLINATION, q.omm.RA_OF_ASC_NODE, q.omm.ARG_OF_PERICENTER, q.omm.MEAN_ANOMALY, q.omm.BSTAR].join('|'); };
  const tStart = Date.now();
  for (let s = 0; s <= nSteps; s++) {
    const tm = t0 + s * DT;
    for (let i = 0; i < N; i++) {
      const p = props[i];
      const pv = p ? satellite.sgp4(p.satrec, (tm - p.epochMs) / 60_000) : null;
      const r = pv ? pv.position : null;
      if (!r || typeof r === 'boolean' || !Number.isFinite(r.x)) { pos[3 * i] = NaN; continue; }
      pos[3 * i] = r.x; pos[3 * i + 1] = r.y; pos[3 * i + 2] = r.z;
    }
    targets.forEach((ti, k) => {
      for (let j = 0; j < N; j++) {
        if (j === ti || pos[3 * j] !== pos[3 * j]) { prev2[k]![j] = prevD[k]![j]!; prevD[k]![j] = Infinity; continue; }
        const ex = pos[3 * j]! - pos[3 * ti]!, ey = pos[3 * j + 1]! - pos[3 * ti + 1]!, ez = pos[3 * j + 2]! - pos[3 * ti + 2]!;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        const a = prev2[k]![j]!, b = prevD[k]![j]!;
        // local minimum at the previous step (b <= a and b <= d) and small: refine
        if (s >= 2 && b < 40 && b <= a && b <= d && !identical(ti, j)) {
          const tc = tm - DT;
          let l = tc - DT, h = tc + DT;
          for (let it = 0; it < 30; it++) { const x1 = h - GR * (h - l), x2 = l + GR * (h - l); if (dist(props[ti]!, props[j]!, x1) < dist(props[ti]!, props[j]!, x2)) h = x2; else l = x1; }
          const tb = (l + h) / 2, db = dist(props[ti]!, props[j]!, tb);
          if (db < 5 && tb >= t0 && tb <= t1 && !formPairs.has([cat[ti]!.noradId, cat[j]!.noradId].sort((x, y) => x - y).join('-'))) found.push({ ti, j, d: db, t: tb, v: 0 });
        }
        prev2[k]![j] = b; prevD[k]![j] = d;
      }
    });
  }
  const seen = new Set<string>();
  const uniq = found.filter((f) => { const k = [cat[f.ti]!.noradId, cat[f.j]!.noradId].sort((x, y) => x - y).join('-') + '@' + Math.round(f.t / 5000); if (seen.has(k)) return false; seen.add(k); return true; });
  found.length = 0; found.push(...uniq);
  let matched = 0;
  const missing: string[] = [];
  const tIds = new Set(targets.map((i) => cat[i]!.noradId));
  for (const f of found) {
    const a = cat[f.ti]!.noradId, b = cat[f.j]!.noradId;
    const hit = full.find((r) => ((r[0] === a && r[1] === b) || (r[0] === b && r[1] === a)) && Math.abs(r[2] - f.t) < 20_000);
    if (hit) matched++; else missing.push(`${a}-${b} ${new Date(f.t).toISOString()} d=${f.d.toFixed(3)}`);
  }
  const inWindow = full.filter((r) => r[2] >= t0 && r[2] <= t1 && (tIds.has(r[0]) || tIds.has(r[1]))).length;
  console.log(`CA recall ${day} ${h0}h+${hours}h, ${tIds.size} target objects (ISS + ${busiest.length} busiest + random), formation pairs excluded (${formPairs.size} in that day's close.formation): brute (2 s + golden section) ${found.length} approaches < 5 km; in derived full set ${matched} => recall ${((100 * matched) / Math.max(1, found.length)).toFixed(2)}%; derived full set has ${inWindow} events involving the targets in the window (incl. repeats); brute took ${((Date.now() - tStart) / 1000).toFixed(0)} s`);
  if (missing.length) console.log('MISSING from derived set:\n' + missing.slice(0, 20).join('\n'));
}

if (mode === 'ca-exact') {
  // five stored approaches recomputed with a brute 10 ms scan over +-20 s (no optimiser), from the raw catalog of that day
  const rows = (await client.query(`(SELECT day::text AS day, subjects, extract(epoch from t_start)::float8*1000 AS t, payload FROM starmap.event WHERE kind='close.approach' AND payload->>'cat'='same_family' ORDER BY md5(id::text || 'x') LIMIT 3) UNION ALL (SELECT day::text AS day, subjects, extract(epoch from t_start)::float8*1000 AS t, payload FROM starmap.event WHERE kind='close.approach' AND payload->>'cat'<>'same_family' ORDER BY md5(id::text || 'y') LIMIT 2)`)).rows as Array<{ day: string; subjects: number[]; t: number; payload: { d: number; v: number } }>;
  for (const r of rows) {
    const cat = loadDayCatalog(r.day);
    const [A, B] = r.subjects.map((id) => makeProp(cat.find((o) => o.noradId === id)!.omm)!) as [Prop, Prop];
    let best = Infinity, bt = 0, vrel = 0;
    for (let q = -20000; q <= 20000; q += 10) {
      const tm = r.t + q;
      const pa = satellite.sgp4(A.satrec, (tm - A.epochMs) / 60_000), pb = satellite.sgp4(B.satrec, (tm - B.epochMs) / 60_000);
      const ra = (pa as { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number } }), rb = (pb as typeof ra);
      const d = Math.hypot(ra.position.x - rb.position.x, ra.position.y - rb.position.y, ra.position.z - rb.position.z);
      if (d < best) { best = d; bt = tm; vrel = Math.hypot(ra.velocity.x - rb.velocity.x, ra.velocity.y - rb.velocity.y, ra.velocity.z - rb.velocity.z); }
    }
    console.log(`exact ${r.subjects.join('-')} ${r.day} [${(r.payload as { cat?: string }).cat}]: stored ${r.payload.d} km, ${r.payload.v} km/s @ ${new Date(r.t).toISOString()}; brute 10 ms scan ${best.toFixed(3)} km, ${vrel.toFixed(2)} km/s @ ${new Date(bt).toISOString()}; |dd| ${Math.abs(best - r.payload.d).toFixed(3)} km, |dt| ${(Math.abs(bt - r.t) / 1000).toFixed(2)} s`);
  }
}

if (mode === 'formation') {
  const rows = (await client.query(`SELECT day::text AS day, subjects, payload FROM starmap.event WHERE kind='close.formation' ORDER BY md5(id::text || 'f') LIMIT 5`)).rows as Array<{ day: string; subjects: number[]; payload: { frac: number; minKm: number } }>;
  for (const r of rows) {
    const cat = loadDayCatalog(r.day);
    const [A, B] = r.subjects.map((id) => makeProp(cat.find((o) => o.noradId === id)!.omm)!) as [Prop, Prop];
    const t0 = dayStartMs(r.day);
    let inside = 0, min = Infinity;
    for (let k = 0; k < 1440; k++) { // every 60 s, the same grid the derive uses, but own code
      const tm = t0 + k * 60_000;
      const pa = satellite.sgp4(A.satrec, (tm - A.epochMs) / 60_000), pb = satellite.sgp4(B.satrec, (tm - B.epochMs) / 60_000);
      const ra = (pa as unknown as { position: { x: number; y: number; z: number } }).position, rb = (pb as unknown as { position: { x: number; y: number; z: number } }).position;
      const d = Math.sqrt((ra.x - rb.x) ** 2 + (ra.y - rb.y) ** 2 + (ra.z - rb.z) ** 2);
      if (d <= 50) inside++;
      if (d < min) min = d;
    }
    console.log(`formation ${r.subjects.join('-')} ${r.day} (${cat.find((o) => o.noradId === r.subjects[0])!.name} / ${cat.find((o) => o.noradId === r.subjects[1])!.name}): stored frac ${r.payload.frac} min ${r.payload.minKm} km; recomputed at 60 s: frac ${(inside / 1440).toFixed(3)} min ${min.toFixed(3)} km`);
  }
}

if (mode === 'diff') {
  // appeared / disappeared recomputed as plain set differences of the raw history files for three days
  for (const day of ['2026-09-24', '2026-10-07', '2026-10-15']) {
    const prevDay = new Date(Date.parse(day) - DAY_MS).toISOString().slice(0, 10);
    const cur = new Set(loadDayCatalog(day).map((o) => o.noradId)), prev = new Set(loadDayCatalog(prevDay).map((o) => o.noradId));
    const app = [...cur].filter((x) => !prev.has(x)).sort((a, b) => a - b), dis = [...prev].filter((x) => !cur.has(x)).sort((a, b) => a - b);
    const q = async (kind: string) => ((await client.query(`SELECT subjects[1] AS id FROM starmap.event WHERE kind=$1 AND day=$2 ORDER BY 1`, [kind, day])).rows as Array<{ id: number }>).map((r) => r.id);
    const sa = await q('object.appeared'), sd = await q('object.disappeared');
    console.log(`${day}: appeared by set difference ${app.length}, stored ${sa.length}, identical ${JSON.stringify(app) === JSON.stringify(sa)}; disappeared ${dis.length}, stored ${sd.length}, identical ${JSON.stringify(dis) === JSON.stringify(sd)}`);
  }
}

if (mode === 'jumps') {
  const rows = (await client.query(`SELECT day::text AS day, subjects[1] AS id, payload FROM starmap.event WHERE kind='elements.jump' ORDER BY md5(id::text) LIMIT 5`)).rows as Array<{ day: string; id: number; payload: Record<string, unknown> }>;
  const prevD = (d: string) => new Date(Date.parse(d) - DAY_MS).toISOString().slice(0, 10);
  for (const r of rows) {
    const o1 = loadDayCatalog(r.day).find((o) => o.noradId === r.id)!, o0 = loadDayCatalog(prevD(r.day)).find((o) => o.noradId === r.id)!;
    // by hand: semi-major axis from mean motion, then SGP4 of the OLD element set at the NEW epoch vs the NEW set at its epoch
    const a0 = semiMajorKm(o0.omm), a1 = semiMajorKm(o1.omm);
    const p0 = makeProp(o0.omm)!, p1 = makeProp(o1.omm)!;
    const tN = epochMsOf(o1.omm);
    const A = satellite.sgp4(p0.satrec, (tN - p0.epochMs) / 60_000), B = satellite.sgp4(p1.satrec, 0);
    const ra = (A as { position: { x: number; y: number; z: number } }).position, rb = (B as { position: { x: number; y: number; z: number } }).position;
    const dpos = Math.hypot(ra.x - rb.x, ra.y - rb.y, ra.z - rb.z);
    console.log(`jump ${r.day} ${r.id} ${o1.name}: old n=${o0.omm.MEAN_MOTION} (a=${a0.toFixed(2)} km, epoch ${o0.omm.EPOCH}) new n=${o1.omm.MEAN_MOTION} (a=${a1.toFixed(2)} km, epoch ${o1.omm.EPOCH}); by hand da=${(a1 - a0).toFixed(3)} km, dpos=${dpos.toFixed(2)} km | stored da=${r.payload.da} dpos=${r.payload.dpos} (${r.payload.dir})`);
  }
}
await client.end();
