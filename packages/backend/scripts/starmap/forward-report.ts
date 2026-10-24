// ============================================================
// SPIKE — not production. S5 report: reads the batch files written by screen-forward.ts, matches events across successive batches
// (same pair, TCA within 60 s), writes starmap.conjunction + starmap.conjunction_update, and prints the tables.
//   export STARMAP_DB=postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch
//   npx tsx packages/backend/scripts/starmap/forward-report.ts [--from 2026-10-12] [--to 2026-10-18] [--no-db]
// Rebuilds both tables from the files every time (TRUNCATE + insert in one transaction), so it is safe to re-run.
// Persistence is measured on the overlap of two successive batches: batch k covers [T_k, T_k + 36 h]; batch k+1 starts 24 h later, so
// the part [T_k + 24 h, T_k + 36 h] is predicted twice. Events there are matched; the rest cannot be compared. A 60 s margin at both
// ends of the overlap is excluded (a closest approach cut by the window edge).
// ============================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import * as satellite from 'satellite.js';
import { parseArgs } from './catalog.js';
import { makeProp, type Prop } from './runs.js';
import { DB_URL } from './events.js';
import { batchFile, FORWARD_DIR } from './screen-forward.js';
import { batchTimeMs, causalCatalog, matchEvents, quantile, type FwdEvent } from './forward-lib.js';

const args = parseArgs(process.argv.slice(2));
const FROM = args.get('from') ?? '2026-10-12', TO = args.get('to') ?? '2026-10-18';
const DAYS: string[] = [];
for (let d = Date.parse(FROM + 'T00:00:00Z'); d <= Date.parse(TO + 'T00:00:00Z'); d += 86_400_000) DAYS.push(new Date(d).toISOString().slice(0, 10));
const TOL = 60_000, EDGE = 60_000;

interface Meta { day: string; batchTime: string; windowEnd: string; timing: Record<string, number>; sgp4Calls: Record<string, number>; maxRssMB: number; events: Record<string, number>; pcCounts: Record<string, Record<string, number>>; pcQuantiles: Record<string, Record<string, number>>; objects: Record<string, number>; grid: Record<string, number> }
const load = (day: string): { ev: FwdEvent[]; meta: Meta } => ({
  ev: gunzipSync(readFileSync(batchFile(day))).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FwdEvent),
  meta: JSON.parse(readFileSync(batchFile(day, '', 'meta.json'), 'utf8')) as Meta,
});
const sci = (x: number) => (x === 0 ? '0' : x.toExponential(2));
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const qs = (a: number[]) => { const s = sorted(a); return `${f2(quantile(s, 0.5))} / ${f2(quantile(s, 0.9))} / ${f2(quantile(s, 0.99))}`; };

// ---------------- exact miss of a pair near a time, in another batch's element sets ----------------
function minDist(a: Prop, b: Prop, tc: number): number {
  const d = (t: number) => {
    const pa = satellite.sgp4(a.satrec, (t - a.epochMs) / 60_000), pb = satellite.sgp4(b.satrec, (t - b.epochMs) / 60_000);
    const ra = pa ? pa.position : null, rb = pb ? pb.position : null;
    if (!ra || !rb || typeof ra === 'boolean' || typeof rb === 'boolean') return Infinity;
    return Math.hypot(ra.x - rb.x, ra.y - rb.y, ra.z - rb.z);
  };
  let best = Infinity, bt = tc;
  for (let q = -120_000; q <= 120_000; q += 500) { const v = d(tc + q); if (v < best) { best = v; bt = tc + q; } }
  let l = bt - 500, h = bt + 500;
  const GR = 0.6180339887498949;
  for (let it = 0; it < 30; it++) { const x1 = h - GR * (h - l), x2 = l + GR * (h - l); if (d(x1) < d(x2)) h = x2; else l = x1; }
  return Math.min(best, d((l + h) / 2));
}
const propsOf = (day: string) => {
  const cc = causalCatalog(day);
  const m = new Map<number, Prop | null>();
  const lazy = new Map(cc.objs.map((o) => [o.noradId, o]));
  return (id: number): Prop | null | undefined => { if (!lazy.has(id)) return undefined; if (!m.has(id)) m.set(id, makeProp(lazy.get(id)!.omm)); return m.get(id); };
};

async function main(): Promise<void> {
  const missing = DAYS.filter((d) => !existsSync(batchFile(d, '', 'meta.json')));
  if (missing.length) { console.error('missing batches: ' + missing.join(', ')); process.exit(1); }
  const B = DAYS.map(load);
  const out: Record<string, unknown> = {};

  // ---------- per-batch table ----------
  console.log('\n## per batch');
  console.log('| batch (12:00 UTC) | screened | wall s | grid s | refine s | Pc s | SGP4 calls (M) | peak RSS MB | <5 km | <1 km | <0.5 km |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const b of B) { const m = b.meta; console.log(`| ${m.day} | ${m.objects.screened} | ${m.timing.total} | ${m.timing.grid} | ${m.timing.refine} | ${m.timing.pc} | ${(m.sgp4Calls.total! / 1e6).toFixed(0)} | ${m.maxRssMB} | ${m.events.lt5} | ${m.events.lt1} | ${m.events.lt05} |`); }
  console.log('\n## Pc counts per batch (events with Pc above threshold): balanced / conservative / max-possible');
  console.log('| batch | >1e-6 | >1e-5 | >1e-4 | no-floor balanced >1e-6 / >1e-5 / >1e-4 |');
  console.log('|---|---|---|---|---|');
  for (const b of B) { const c = b.meta.pcCounts; const t = (k: string) => `${c.balanced![k]} / ${c.conservative![k]} / ${c.max![k]}`; console.log(`| ${b.meta.day} | ${t('gt1e6')} | ${t('gt1e5')} | ${t('gt1e4')} | ${c.balancedNoFloor!.gt1e6} / ${c.balancedNoFloor!.gt1e5} / ${c.balancedNoFloor!.gt1e4} |`); }
  out.batches = B.map((b) => b.meta);

  // ---------- identities and persistence ----------
  const idOf: Int32Array[] = [];
  let nextId = 1;
  const persist: Array<Record<string, unknown>> = [];
  const matchedPairs: Array<{ prev: FwdEvent; next: FwdEvent }> = [];
  for (let k = 0; k < B.length; k++) {
    const ev = B[k]!.ev;
    idOf.push(new Int32Array(ev.length));
    if (k === 0) { for (let i = 0; i < ev.length; i++) idOf[0]![i] = nextId++; continue; }
    const prev = B[k - 1]!.ev;
    const mt = matchEvents(prev, ev, TOL);
    for (let j = 0; j < ev.length; j++) idOf[k]![j] = mt[j]! >= 0 ? idOf[k - 1]![mt[j]!]! : nextId++;
    // overlap analysis
    const T1 = batchTimeMs(B[k]!.meta.day), End0 = Date.parse(B[k - 1]!.meta.windowEnd);
    const lo = T1 + EDGE, hi = End0 - EDGE;
    const prevCore = prev.map((e, i) => [e, i] as const).filter(([e]) => e.tca >= lo && e.tca <= hi);
    const nextCore = ev.map((e, j) => [e, j] as const).filter(([e]) => e.tca >= lo && e.tca <= hi);
    const matchedPrev = new Set<number>();
    for (let j = 0; j < ev.length; j++) if (mt[j]! >= 0) matchedPrev.add(mt[j]!);
    const persisted = prevCore.filter(([, i]) => matchedPrev.has(i));
    const vanished = prevCore.filter(([, i]) => !matchedPrev.has(i));
    const added = nextCore.filter(([, j]) => mt[j]! < 0);
    const pm = nextCore.filter(([, j]) => mt[j]! >= 0).map(([e, j]) => ({ prev: prev[mt[j]!]!, next: e }));
    matchedPairs.push(...pm);
    const updated = pm.filter((p) => p.prev.epA !== p.next.epA || p.prev.epB !== p.next.epB);
    const dT = pm.map((p) => Math.abs(p.next.tca - p.prev.tca) / 1000), dM = pm.map((p) => Math.abs(p.next.miss - p.prev.miss));
    const lr = pm.filter((p) => p.prev.pcBal > 0 && p.next.pcBal > 0).map((p) => Math.abs(Math.log10(p.next.pcBal / p.prev.pcBal)));
    // why unmatched events are unmatched: recompute the pair in the other batch's element sets
    const propNext = propsOf(B[k]!.meta.day), propPrev = propsOf(B[k - 1]!.meta.day);
    const bins = ['<5 km (TCA moved >60 s or dedup)', '5-6 km (threshold flicker)', '6-10 km', '10-50 km', '>=50 km', 'object absent'];
    const diag = (list: Array<readonly [FwdEvent, number]>, propOther: ReturnType<typeof propsOf>) => {
      const h = new Array(bins.length).fill(0) as number[];
      const far: FwdEvent[] = [];
      for (const [e] of list) {
        const pa = propOther(e.a), pb = propOther(e.b);
        if (!pa || !pb) { h[5]!++; continue; }
        const d = minDist(pa, pb, e.tca);
        const bi = d < 5 ? 0 : d < 6 ? 1 : d < 10 ? 2 : d < 50 ? 3 : 4;
        h[bi]!++;
        if (bi >= 3) far.push(e);
      }
      return { h, far };
    };
    const dv = diag(vanished, propNext), dn = diag(added, propPrev);
    const hiPrev = (e: FwdEvent) => e.pcBal > 1e-5 || e.pcCons > 1e-5;
    const alertPrev = pm.filter((p) => hiPrev(p.prev)), alertKept = alertPrev.filter((p) => hiPrev(p.next));
    const alertNew = pm.filter((p) => !hiPrev(p.prev) && hiPrev(p.next));
    const vanAlert = vanished.filter(([e]) => hiPrev(e)).length, addAlert = added.filter(([e]) => hiPrev(e)).length;
    persist.push({
      from: B[k - 1]!.meta.day, to: B[k]!.meta.day, overlapHours: +((hi - lo) / 3.6e6).toFixed(2),
      prevCore: prevCore.length, nextCore: nextCore.length, persisted: persisted.length, vanished: vanished.length, added: added.length,
      updated: updated.length, identicalSets: pm.length - updated.length,
      dTcaQ: qs(dT), dMissQ: qs(dM), dLogPcQ: qs(lr),
      vanishedDiag: Object.fromEntries(bins.map((b, i) => [b, dv.h[i]])), addedDiag: Object.fromEntries(bins.map((b, i) => [b, dn.h[i]])),
      lt1prev: prevCore.filter(([e]) => e.miss < 1).length, lt1persisted: persisted.filter(([e]) => e.miss < 1).length,
      alertPrev: alertPrev.length + vanAlert, alertKept: alertKept.length, alertNewFromMatched: alertNew.length, alertVanished: vanAlert, alertAddedUnmatched: addAlert,
      keptByClass: (() => { const fr = (f: (e: FwdEvent) => boolean) => { const l = prevCore.filter(([e]) => f(e)); return `${l.length ? (100 * l.filter(([, i]) => matchedPrev.has(i)).length / l.length).toFixed(1) : 'n/a'}% of ${l.length}`; }; return { manoeuvrableEither: fr((e) => e.manA || e.manB), neitherManoeuvrable: fr((e) => !(e.manA || e.manB)), crossing: fr((e) => e.cat === 'crossing'), sameFamily: fr((e) => e.cat === 'same_family'), under1km: fr((e) => e.miss < 1), pcBalOver1e5: fr((e) => e.pcBal > 1e-5) }; })(),
      reallyGoneOfPrevCore: dv.far.length, reallyNewOfNextCore: dn.far.length,
    });
  }
  console.log('\n## persistence between successive batches (overlap = last 12 h of batch k = first 12 h of batch k+1; 60 s edge excluded)');
  console.log('| from -> to | events in overlap (old / new run) | persisted | vanished | new | updated (a set changed) | |dTCA| s p50/p90/p99 | |dmiss| km p50/p90/p99 | |dlog10 Pc| p50/p90/p99 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const p of persist) console.log(`| ${p.from} -> ${p.to} | ${p.prevCore} / ${p.nextCore} | ${p.persisted} (${(100 * (p.persisted as number) / (p.prevCore as number)).toFixed(1)}%) | ${p.vanished} | ${p.added} | ${p.updated} | ${p.dTcaQ} | ${p.dMissQ} | ${p.dLogPcQ} |`);
  console.log('\n### what the vanished / new events are, checked by recomputing the pair in the other run\'s element sets (miss there)');
  for (const p of persist) console.log(`${p.from}->${p.to}: vanished ${JSON.stringify(p.vanishedDiag)}; new ${JSON.stringify(p.addedDiag)}; under 1 km in old run ${p.lt1prev}, still matched ${p.lt1persisted}; Pc>1e-5 alerts (balanced or conservative) in old run overlap ${p.alertPrev}, kept ${p.alertKept} (new alerts from matched events ${p.alertNewFromMatched}; vanished-unmatched alerts ${p.alertVanished}; new-unmatched alerts ${p.alertAddedUnmatched})`);
  console.log('\n### share of old-run overlap events that were found again, by class');
  for (const p of persist) console.log(`${p.from}->${p.to}: ${JSON.stringify(p.keptByClass)}`);
  out.persistence = persist;

  // by manoeuvrable
  const grp = (f: (p: { prev: FwdEvent; next: FwdEvent }) => boolean) => matchedPairs.filter(f);
  const man = grp((p) => p.prev.manA || p.prev.manB), non = grp((p) => !(p.prev.manA || p.prev.manB));
  console.log(`\n### matched events, stability by class (all successive pairs pooled)`);
  console.log('| class | matched | |dTCA| s p50/p90/p99 | |dmiss| km p50/p90/p99 | |dlog10 Pc bal| p50/p90/p99 |');
  console.log('|---|---|---|---|---|');
  for (const [n, l] of [['manoeuvrable either', man], ['neither manoeuvrable', non]] as const) {
    const lr = l.filter((p) => p.prev.pcBal > 0 && p.next.pcBal > 0).map((p) => Math.abs(Math.log10(p.next.pcBal / p.prev.pcBal)));
    console.log(`| ${n} | ${l.length} | ${qs(l.map((p) => Math.abs(p.next.tca - p.prev.tca) / 1000))} | ${qs(l.map((p) => Math.abs(p.next.miss - p.prev.miss)))} | ${qs(lr)} |`);
  }

  // ---------- identities ----------
  interface Ident { id: number; obs: Array<{ k: number; e: FwdEvent }> }
  const ids = new Map<number, Ident>();
  B.forEach((b, k) => b.ev.forEach((e, i) => { const id = idOf[k]![i]!; const x = ids.get(id); if (x) x.obs.push({ k, e }); else ids.set(id, { id, obs: [{ k, e }] }); }));
  const nObs = new Array(B.length + 1).fill(0) as number[];
  for (const x of ids.values()) nObs[x.obs.length]!++;
  const lead = [...ids.values()].map((x) => (x.obs[0]!.e.tca - batchTimeMs(B[x.obs[0]!.k]!.meta.day)) / 3.6e6);
  console.log(`\n## identities across ${B.length} batches: ${ids.size} distinct conjunctions; observed in n batches: ${nObs.slice(1).map((c, i) => `${i + 1}:${c}`).join(' ')}`);
  const everAbove = (thr: number, key: 'pcBal' | 'pcCons' | 'pcMax') => [...ids.values()].filter((x) => x.obs.some((o) => o.e[key] > thr)).length;
  const lastAbove = (thr: number, key: 'pcBal' | 'pcCons' | 'pcMax') => [...ids.values()].filter((x) => x.obs[x.obs.length - 1]!.e[key] > thr).length;
  console.log('| threshold | balanced ever / in last obs | conservative ever / last | max-possible ever / last |');
  console.log('|---|---|---|---|');
  for (const t of [1e-6, 1e-5, 1e-4]) console.log(`| ${t} | ${everAbove(t, 'pcBal')} / ${lastAbove(t, 'pcBal')} | ${everAbove(t, 'pcCons')} / ${lastAbove(t, 'pcCons')} | ${everAbove(t, 'pcMax')} / ${lastAbove(t, 'pcMax')} |`);
  out.identities = { distinct: ids.size, nObs, leadHoursQ: qs(lead) };

  // first-seen lead time of the identities that ever exceed 1e-5 (balanced)
  const hot = [...ids.values()].filter((x) => x.obs.some((o) => o.e.pcBal > 1e-5));
  const hotLead = hot.map((x) => (x.obs[0]!.e.tca - batchTimeMs(B[x.obs[0]!.k]!.meta.day)) / 3.6e6);
  console.log(`first-seen lead time (hours before TCA, p50/p90/p99): all ${qs(lead)}; those that ever exceed Pc 1e-5 (balanced): ${hot.length}, ${qs(hotLead)}`);
  // along a chain: Pc when first seen vs last seen
  const chains = [...ids.values()].filter((x) => x.obs.length >= 2);
  const swing = chains.map((x) => { const l = x.obs.map((o) => Math.log10(Math.max(o.e.pcBal, 1e-30))); return Math.max(...l) - Math.min(...l); });
  console.log(`chains seen in 2+ batches: ${chains.length}; spread of log10 Pc balanced along a chain (max - min) p50/p90/p99: ${qs(swing)}`);

  // ---------- top 10 events ----------
  const topOf = (list: FwdEvent[], n = 10, key: 'pcBal' | 'pcCons' = 'pcBal') => [...list].sort((x, y) => y[key] - x[key]).slice(0, n);
  const row = (e: FwdEvent) => `| ${e.nameA} (${e.a}) / ${e.nameB} (${e.b}) | ${new Date(e.tca).toISOString().slice(5, 19).replace('T', ' ')} | ${e.miss.toFixed(3)} | ${e.vrel.toFixed(1)} | ${e.ageA.toFixed(1)} / ${e.ageB.toFixed(1)} | ${(e.hbr * 1000).toFixed(1)} | ${sci(e.pcBal)} | ${sci(e.pcCons)} | ${sci(e.pcMax)} | ${e.cat}${e.manA || e.manB ? ', manoeuvrable' : ''}${e.slow ? ', slow' : ''}${e.old ? ', age>14d' : ''} |`;
  const head = '| pair | TCA UTC | miss km | v_rel km/s | ages d | HBR m | Pc balanced | Pc conservative | Pc max | label |\n|---|---|---|---|---|---|---|---|---|---|';
  const midK = Math.floor(B.length / 2);
  console.log(`\n## top 10 events by balanced Pc, batch ${B[midK]!.meta.day}\n${head}`);
  topOf(B[midK]!.ev).forEach((e) => console.log(row(e)));
  console.log(`\n## top 10 events by balanced Pc, batch ${B[B.length - 1]!.meta.day} (last)\n${head}`);
  topOf(B[B.length - 1]!.ev).forEach((e) => console.log(row(e)));
  const best = [...ids.values()].map((x) => x.obs.reduce((m, o) => (o.e.pcBal > m.e.pcBal ? o : m))).sort((x, y) => y.e.pcBal - x.e.pcBal).slice(0, 10);
  console.log(`\n## top 10 distinct conjunctions over all batches (highest balanced Pc over their observations)\n${head.replace('| pair', '| batch | pair')}`);
  best.forEach((o) => console.log(`| ${B[o.k]!.meta.day} ${row(o.e)}`));
  out.top = best.map((o) => ({ batch: B[o.k]!.meta.day, ...o.e }));

  // ---------- manoeuvrable summary ----------
  console.log('\n## manoeuvrable involvement (all batches pooled)');
  const all = B.flatMap((b) => b.ev);
  const mn = all.filter((e) => e.manA || e.manB);
  const frac = (f: (e: FwdEvent) => boolean) => `${all.filter(f).length} of ${all.length} (${(100 * all.filter(f).length / all.length).toFixed(1)}%)`;
  console.log(`events with a manoeuvrable object: ${frac((e) => e.manA || e.manB)}; both: ${frac((e) => e.manA && e.manB)}; jumped in previous 7 d (T2): ${frac((e) => e.jumpA || e.jumpB)}; slow (<0.5 km/s): ${frac((e) => e.slow)}; age>14 d: ${frac((e) => e.old)}`);
  for (const thr of [1e-5, 1e-4]) {
    const hi = all.filter((e) => e.pcBal > thr);
    console.log(`Pc balanced > ${thr}: ${hi.length} events, of which with a manoeuvrable object ${hi.filter((e) => e.manA || e.manB).length}, with a recently jumped object ${hi.filter((e) => e.jumpA || e.jumpB).length}`);
  }
  const cats: Record<string, number> = {};
  for (const e of all) cats[e.cat] = (cats[e.cat] ?? 0) + 1;
  console.log('labels (all batches pooled): ' + JSON.stringify(cats));
  console.log(`median miss<1 km events with manoeuvrable: ${mn.filter((e) => e.miss < 1).length} of ${all.filter((e) => e.miss < 1).length}`);

  // ---------- database ----------
  if (!args.has('no-db')) {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`CREATE SCHEMA IF NOT EXISTS starmap;
      DROP TABLE IF EXISTS starmap.conjunction_update; DROP TABLE IF EXISTS starmap.conjunction;
      CREATE TABLE starmap.conjunction (
        id bigint PRIMARY KEY, norad_a int NOT NULL, norad_b int NOT NULL, name_a text, name_b text,
        first_batch timestamptz NOT NULL, last_batch timestamptz NOT NULL, n_updates int NOT NULL,
        tca_first timestamptz NOT NULL, tca_last timestamptz NOT NULL, miss_km_first real, miss_km_last real,
        pc_balanced_last float8, pc_conservative_last float8, pc_max_last float8, category text, manoeuvrable boolean);
      CREATE TABLE starmap.conjunction_update (
        id bigserial PRIMARY KEY, conjunction_id bigint NOT NULL REFERENCES starmap.conjunction(id), batch_time timestamptz NOT NULL,
        tca timestamptz NOT NULL, miss_km real NOT NULL, vrel_kms real NOT NULL, ric_r_km real, ric_i_km real, ric_c_km real,
        epoch_a timestamptz, epoch_b timestamptz, age_a_d real, age_b_d real, hbr_m real,
        pc_balanced float8, pc_conservative float8, pc_max float8, pc_balanced_nofloor float8, payload jsonb);
      CREATE INDEX conjunction_pair_idx ON starmap.conjunction (norad_a, norad_b);
      CREATE INDEX conjunction_tca_idx ON starmap.conjunction (tca_last);
      CREATE INDEX conjunction_pc_idx ON starmap.conjunction (pc_conservative_last DESC);
      CREATE INDEX conjunction_update_idx ON starmap.conjunction_update (conjunction_id, batch_time);`);
    const iso = (ms: number) => new Date(ms).toISOString();
    const idl = [...ids.values()];
    for (let o = 0; o < idl.length; o += 10_000) {
      const part = idl.slice(o, o + 10_000);
      const fst = part.map((x) => x.obs[0]!), lst = part.map((x) => x.obs[x.obs.length - 1]!);
      await c.query(`INSERT INTO starmap.conjunction SELECT * FROM unnest($1::bigint[], $2::int[], $3::int[], $4::text[], $5::text[], $6::timestamptz[], $7::timestamptz[], $8::int[], $9::timestamptz[], $10::timestamptz[], $11::real[], $12::real[], $13::float8[], $14::float8[], $15::float8[], $16::text[], $17::boolean[])`,
        [part.map((x) => x.id), lst.map((l) => l.e.a), lst.map((l) => l.e.b), lst.map((l) => l.e.nameA), lst.map((l) => l.e.nameB),
          fst.map((f) => iso(batchTimeMs(B[f.k]!.meta.day))), lst.map((l) => iso(batchTimeMs(B[l.k]!.meta.day))), part.map((x) => x.obs.length),
          fst.map((f) => iso(f.e.tca)), lst.map((l) => iso(l.e.tca)), fst.map((f) => f.e.miss), lst.map((l) => l.e.miss),
          lst.map((l) => l.e.pcBal), lst.map((l) => l.e.pcCons), lst.map((l) => l.e.pcMax), lst.map((l) => l.e.cat), lst.map((l) => l.e.manA || l.e.manB)]);
    }
    let nUpd = 0;
    for (let k = 0; k < B.length; k++) {
      const ev = B[k]!.ev, bt = iso(batchTimeMs(B[k]!.meta.day));
      for (let o = 0; o < ev.length; o += 10_000) {
        const p = ev.slice(o, o + 10_000), pid = idOf[k]!.slice(o, o + 10_000);
        await c.query(`INSERT INTO starmap.conjunction_update (conjunction_id, batch_time, tca, miss_km, vrel_kms, ric_r_km, ric_i_km, ric_c_km, epoch_a, epoch_b, age_a_d, age_b_d, hbr_m, pc_balanced, pc_conservative, pc_max, pc_balanced_nofloor, payload)
          SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::timestamptz[], $4::real[], $5::real[], $6::real[], $7::real[], $8::real[], $9::timestamptz[], $10::timestamptz[], $11::real[], $12::real[], $13::real[], $14::float8[], $15::float8[], $16::float8[], $17::float8[], $18::jsonb[])`,
          [Array.from(pid), p.map(() => bt), p.map((e) => iso(e.tca)), p.map((e) => e.miss), p.map((e) => e.vrel), p.map((e) => e.ric[0]), p.map((e) => e.ric[1]), p.map((e) => e.ric[2]),
            p.map((e) => iso(e.epA)), p.map((e) => iso(e.epB)), p.map((e) => e.ageA), p.map((e) => e.ageB), p.map((e) => e.hbr * 1000),
            p.map((e) => e.pcBal), p.map((e) => e.pcCons), p.map((e) => e.pcMax), p.map((e) => e.pcBalNoFloor),
            p.map((e) => JSON.stringify({ cat: e.cat, manA: e.manA, manB: e.manB, jumpA: e.jumpA, jumpB: e.jumpB, slow: e.slow, old: e.old, sMaj: +e.sMaj.toFixed(3), sMin: +e.sMin.toFixed(3) }))]);
        nUpd += p.length;
      }
    }
    await c.query('COMMIT');
    const sz = (await c.query("SELECT pg_total_relation_size('starmap.conjunction') AS a, pg_total_relation_size('starmap.conjunction_update') AS b")).rows[0] as { a: string; b: string };
    console.log(`\n## database: starmap.conjunction ${idl.length} rows (${(Number(sz.a) / 1e6).toFixed(1)} MB), starmap.conjunction_update ${nUpd} rows (${(Number(sz.b) / 1e6).toFixed(1)} MB)`);
    const qt = Date.now();
    const r = await c.query("SELECT count(*)::int AS n FROM starmap.conjunction c JOIN starmap.conjunction_update u ON u.conjunction_id = c.id WHERE c.norad_a = 25544 OR c.norad_b = 25544");
    console.log(`query: all updates of conjunctions involving the ISS: ${r.rows[0].n} rows in ${Date.now() - qt} ms`);
    await c.end();
  }
  writeFileSync(FORWARD_DIR + 'summary.json', JSON.stringify(out, null, 1));
}
await main();
