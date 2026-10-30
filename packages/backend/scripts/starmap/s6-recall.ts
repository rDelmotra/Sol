// ============================================================
// SPIKE — not production. S6 recall: compares an S6 batch with a reference batch of the same day and window.
//   npx tsx packages/backend/scripts/starmap/s6-recall.ts <day> <s6-tag> <ref> [--tol 2] [--list 15]
//     <ref> = a tag written by `screen-forward.ts --mode ref` (events carry the volume flags), or  s5:<tag>  for an S5 batch
//     (untagged = the original S5 run; its events are all within 5 km). The reference subsets compared:
//        box      closest approach inside the handbook volume of either object (ref files only)
//        sphere5  closest approach within 5 km (ref files and S5 batches)
//   A reference event counts as found when S6 has an event of the same pair with |TCA difference| <= tol seconds.
//   Also reported: S6 events the reference does not have (extras), and the TCA / miss differences of the matches.
// ============================================================
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from './catalog.js';
import { batchFile, readLines } from './forward-common.js';
import { causalCatalog } from './forward-lib.js';
import { makeProp } from './runs.js';
import { SFS_VOLUMES, findMinima, ricBasis, shapeFromOmm, toRic, volumeIdFor, type V3 } from './s6-lib.js';
import * as satellite from 'satellite.js';

interface Rec { a: number; b: number; tca: number; miss: number; box?: boolean; in5?: boolean }
const read = (day: string, tag: string): unknown[] => readLines(batchFile(day, tag)).map((l) => JSON.parse(l) as unknown);

export function loadRecs(day: string, spec: string): { recs: Rec[]; kind: 's6' | 'ref' | 's5' } {
  if (spec.startsWith('s5:')) {
    const tag = spec.slice(3);
    return { kind: 's5', recs: (read(day, tag) as Array<{ a: number; b: number; tca: number; miss: number }>).map((e) => ({ a: e.a, b: e.b, tca: e.tca, miss: e.miss, in5: e.miss < 5 })) };
  }
  const raw = read(day, spec) as Array<Record<string, unknown>>;
  if (raw.length && 'vol' in raw[0]!) {
    return { kind: 's6', recs: (raw as unknown as Array<{ a: number; b: number; tca: number; miss: number; vol: { inA: boolean; inB: boolean; in5: boolean } }>).map((e) => ({ a: e.a, b: e.b, tca: e.tca, miss: e.miss, box: e.vol.inA || e.vol.inB, in5: e.vol.in5 })) };
  }
  return { kind: 'ref', recs: (raw as unknown as Array<{ a: number; b: number; tca: number; miss: number; inA: boolean; inB: boolean; in5: boolean }>).map((e) => ({ a: e.a, b: e.b, tca: e.tca, miss: e.miss, box: e.inA || e.inB, in5: e.in5 })) };
}

/**
 * A reference event is found when S6 has the same pair within tolS seconds, or (very slow pairs, whose distance is flat to micrometres so the
 * minimum's time is ambiguous by seconds) within 60 s with the miss distance equal to 10 m. `loose` counts the second kind.
 */
export function compare(ref: Rec[], s6: Rec[], tolS: number, pick: (r: Rec) => boolean): { n: number; found: number; loose: number; missing: Rec[]; maxDt: number; maxDmiss: number } {
  const by = new Map<number, Rec[]>();
  for (const e of s6) { const k = e.a * 4_294_967_296 + e.b; (by.get(k) ?? by.set(k, []).get(k)!).push(e); }
  let n = 0, found = 0, loose = 0, maxDt = 0, maxDmiss = 0;
  const missing: Rec[] = [];
  for (const r of ref) {
    if (!pick(r)) continue;
    n++;
    const near = (by.get(r.a * 4_294_967_296 + r.b) ?? []).filter((e) => Math.abs(e.tca - r.tca) <= 60_000).sort((x, y) => Math.abs(x.tca - r.tca) - Math.abs(y.tca - r.tca));
    const c = near.find((e) => Math.abs(e.tca - r.tca) <= tolS * 1000);
    const l = c ? undefined : near.find((e) => Math.abs(e.miss - r.miss) <= 0.01);
    if (c) { found++; maxDt = Math.max(maxDt, Math.abs(c.tca - r.tca)); maxDmiss = Math.max(maxDmiss, Math.abs(c.miss - r.miss)); }
    else if (l) { found++; loose++; maxDmiss = Math.max(maxDmiss, Math.abs(l.miss - r.miss)); }
    else missing.push(r);
  }
  return { n, found, loose, missing, maxDt, maxDmiss };
}

/** Is the reference event a true local minimum of the miss distance? (d at tca +-2 s and +-20 s must both exceed d at the best time within +-1 s) */
export function isLocalMin(day: string, recs: Rec[]): boolean[] {
  const cc = causalCatalog(day), by = new Map(cc.objs.map((o) => [o.noradId, o]));
  return recs.map((r) => {
    const A = by.get(r.a), B = by.get(r.b);
    const pa = A && makeProp(A.omm), pb = B && makeProp(B.omm);
    if (!pa || !pb) return false;
    const d = (t: number): number => { const x = satellite.sgp4(pa.satrec, (t - pa.epochMs) / 60000), y = satellite.sgp4(pb.satrec, (t - pb.epochMs) / 60000); if (!x || !y || typeof x.position === 'boolean' || typeof y.position === 'boolean') return Infinity; return Math.hypot(x.position.x - y.position.x, x.position.y - y.position.y, x.position.z - y.position.z); };
    let best = Infinity, bt = r.tca;
    for (let q = -1000; q <= 1000; q += 5) { const v = d(r.tca + q); if (v < best) { best = v; bt = r.tca + q; } }
    return d(bt - 2000) > best && d(bt + 2000) > best && d(bt - 20000) > best && d(bt + 20000) > best && Math.abs(bt - r.tca) < 999;
  });
}

/** For a reference event: how far (km) the closest-approach point lies outside the nearest handbook volume box, at the exact root of r.v (negative = inside). */
export function boxMargin(day: string, r: Rec): number {
  const cc = causalCatalog(day), by = new Map(cc.objs.map((o) => [o.noradId, o]));
  const A = by.get(r.a)!, B = by.get(r.b)!, pa = makeProp(A.omm)!, pb = makeProp(B.omm)!;
  const st = (p: NonNullable<ReturnType<typeof makeProp>>, t: number) => { const o = satellite.sgp4(p.satrec, (t - p.epochMs) / 60000) as { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number } }; return { r: [o.position.x, o.position.y, o.position.z] as V3, v: [o.velocity.x, o.velocity.y, o.velocity.z] as V3 }; };
  const rel = (t: number) => { const a = st(pa, t), b = st(pb, t); return { r: [b.r[0] - a.r[0], b.r[1] - a.r[1], b.r[2] - a.r[2]] as V3, v: [b.v[0] - a.v[0], b.v[1] - a.v[1], b.v[2] - a.v[2]] as V3 }; };
  const t = findMinima(rel, r.tca - 20_000, r.tca + 20_000, 1000, 0.01)[0] ?? r.tca;
  const a = st(pa, t), b = st(pb, t), d: V3 = [b.r[0] - a.r[0], b.r[1] - a.r[1], b.r[2] - a.r[2]];
  const out = (ric: V3, v: { u: number; v: number; w: number }) => Math.max(Math.abs(ric[0]) - v.u, Math.abs(ric[1]) - v.v, Math.abs(ric[2]) - v.w);
  const va = SFS_VOLUMES[volumeIdFor(shapeFromOmm(A.omm)) - 1]!, vb = SFS_VOLUMES[volumeIdFor(shapeFromOmm(B.omm)) - 1]!;
  return Math.min(out(toRic(d, ricBasis(a.r, a.v)!), va), out(toRic([-d[0], -d[1], -d[2]], ricBasis(b.r, b.v)!), vb));
}

if (process.argv[1] && process.argv[1].endsWith('s6-recall.ts')) {
  const args = parseArgs(process.argv.slice(5));
  const day = process.argv[2]!, tag = process.argv[3]!, refSpec = process.argv[4]!;
  const tol = Number(args.get('tol') ?? 2), list = Number(args.get('list') ?? 15);
  const s6 = loadRecs(day, tag).recs;
  const rf = loadRecs(day, refSpec);
  const fmt = (r: Rec) => `${r.a}-${r.b} ${new Date(r.tca).toISOString()} miss ${r.miss.toFixed(3)}`;
  const out: string[] = [];
  const subsets: Array<[string, (r: Rec) => boolean, (r: Rec) => boolean]> = [];
  if (rf.kind !== 's5') subsets.push(['box (inside either object\'s handbook volume)', (r) => !!r.box, (r) => !!r.box]);
  subsets.push(['sphere 5 km', (r) => !!r.in5, (r) => !!r.in5]);
  for (const [name, pickRef, pickS6] of subsets) {
    const c = compare(rf.recs, s6, tol, pickRef);
    const extra = compare(s6, rf.recs, tol, pickS6);
    out.push(`RECALL ${day} ${tag} vs ${refSpec} [${name}]: reference ${c.n}, found ${c.found} (${c.loose} only by the slow-pair rule) => ${((100 * c.found) / Math.max(1, c.n)).toFixed(4)}%; max |TCA diff| (strict matches) ${(c.maxDt / 1000).toFixed(3)} s, max |miss diff| ${c.maxDmiss.toFixed(4)} km; S6 events not in the reference: ${extra.missing.length} of ${extra.n}`);
    if (c.missing.length) {
      const lm = isLocalMin(day, c.missing);
      const real = c.missing.filter((_, i) => lm[i]);
      if (name.startsWith('box')) out.push(`  true local minima missing, distance outside the nearest volume box at the exact root (km): ${real.map((m) => boxMargin(day, m).toExponential(2)).join(' ')}`);
      out.push(`  MISSING ${c.missing.length}: of these ${real.length} are true local minima of the miss distance, ${c.missing.length - real.length} are not (reference artifacts)\n  ` + real.slice(0, list).map(fmt).join('\n  '));
    }
    if (extra.missing.length) out.push(`  EXTRA in S6 (${extra.missing.length}):\n  ` + extra.missing.slice(0, list).map(fmt).join('\n  '));
  }
  console.log(out.join('\n'));
}
