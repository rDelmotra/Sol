// ============================================================
// SPIKE — not production. S5 verification against code that does not share the fast path.
//   npx tsx packages/backend/scripts/starmap/verify-forward.ts recall <day> <tag> [--busy 30] [--random 12]
//        brute force on the slice written by `screen-forward.ts --day <day> --hours 3 --tag <tag>`: the ISS + the busiest objects + random ones
//        against every other object, SGP4 every 2 s, golden-section refine, vs the screener's event list (same pair, TCA within 20 s).
//   npx tsx packages/backend/scripts/starmap/verify-forward.ts exact [--n 5]
//        random stored events (full 36 h batches) recomputed: 10 ms scan over +-20 s from the raw element sets, and Pc rebuilt with an
//        independent covariance projection and a polar numerical integral.
// ============================================================
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as satellite from 'satellite.js';
import { parseArgs, rng } from './catalog.js';
import { makeProp, type Prop } from './runs.js';
import { identicalGroups, posAt, epochMsOf } from './events.js';
import { batchFile, FENCED_IDS } from './screen-forward.js';
import { batchTimeMs, causalCatalog, floorSigma, hardBodyRadiusKm, type FwdEvent } from './forward-lib.js';
import { sigmaRIC } from './uncertainty-model.js';

const mode = process.argv[2] ?? 'recall';
const args = parseArgs(process.argv.slice(mode === 'recall' ? 5 : 3));
const GR = 0.6180339887498949;

type P3 = { x: number; y: number; z: number };
function state(p: Prop, tMs: number): { r: P3; v: P3 } | null {
  const o = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  if (!o || typeof o.position === 'boolean' || typeof o.velocity === 'boolean' || !Number.isFinite(o.position.x)) return null;
  return { r: o.position, v: o.velocity };
}
const dist = (a: Prop, b: Prop, t: number): number => { const A = state(a, t), B = state(b, t); return A && B ? Math.hypot(A.r.x - B.r.x, A.r.y - B.r.y, A.r.z - B.r.z) : Infinity; };

if (mode === 'recall') {
  const day = process.argv[3]!, tag = process.argv[4]!;
  const meta = JSON.parse(readFileSync(batchFile(day, tag, 'meta.json'), 'utf8')) as { grid: { formationPairList: Array<[number, number]> }; hours: number };
  const ev = gunzipSync(readFileSync(batchFile(day, tag))).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FwdEvent);
  const t0 = batchTimeMs(day), t1 = t0 + meta.hours * 3_600_000;
  // same eligible objects as the screener (catalog as of the batch time; fence and garbage-orbit rule), nothing else shared
  const cc = causalCatalog(day);
  const objs = [] as typeof cc.objs; const props: Prop[] = [];
  for (const o of cc.objs) {
    if (FENCED_IDS.has(o.noradId)) continue;
    const p = makeProp(o.omm); if (!p) continue;
    let bad = false;
    for (const t of [t0, (t0 + t1) / 2, t1]) { const r = posAt(p, t); if (!r) { bad = true; break; } const rad = Math.hypot(r[0], r[1], r[2]); if (rad < 6340 || rad > 1e6) { bad = true; break; } }
    if (!bad) { objs.push(o); props.push(p); }
  }
  const N = objs.length;
  const { group } = identicalGroups(objs);
  const formPairs = new Set(meta.grid.formationPairList.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
  const cnt = new Map<number, number>();
  for (const e of ev) { cnt.set(e.a, (cnt.get(e.a) ?? 0) + 1); cnt.set(e.b, (cnt.get(e.b) ?? 0) + 1); }
  const busiest = [...cnt].sort((x, y) => y[1] - x[1]).slice(0, Number(args.get('busy') ?? 30)).map((x) => x[0]);
  const rnd = rng(77);
  const randoms = Array.from({ length: Number(args.get('random') ?? 12) }, () => objs[Math.floor(rnd() * N)]!.noradId);
  const idx = new Map(objs.map((o, i) => [o.noradId, i]));
  const targets = [...new Set([25544, ...busiest, ...randoms])].map((id) => idx.get(id)).filter((i): i is number => i !== undefined);
  const DT = 2000, nSteps = Math.round((t1 - t0) / DT);
  const prev2 = targets.map(() => new Float64Array(N)), prev1 = targets.map(() => new Float64Array(N));
  const pos = new Float64Array(N * 3);
  const found: Array<{ ti: number; j: number; d: number; t: number }> = [];
  const T = Date.now();
  for (let s = 0; s <= nSteps; s++) {
    const tm = t0 + s * DT;
    for (let i = 0; i < N; i++) { const st = state(props[i]!, tm); if (!st) { pos[3 * i] = NaN; continue; } pos[3 * i] = st.r.x; pos[3 * i + 1] = st.r.y; pos[3 * i + 2] = st.r.z; }
    targets.forEach((ti, k) => {
      for (let j = 0; j < N; j++) {
        if (j === ti || pos[3 * j] !== pos[3 * j] || pos[3 * ti] !== pos[3 * ti]) { prev2[k]![j] = prev1[k]![j]!; prev1[k]![j] = Infinity; continue; }
        const d = Math.hypot(pos[3 * j]! - pos[3 * ti]!, pos[3 * j + 1]! - pos[3 * ti + 1]!, pos[3 * j + 2]! - pos[3 * ti + 2]!);
        const a = prev2[k]![j]!, b = prev1[k]![j]!;
        if (s >= 2 && b < 40 && b <= a && b <= d && !(group[ti]! >= 0 && group[ti] === group[j])) {
          const tc = tm - DT;
          let l = tc - DT, h = tc + DT;
          for (let it = 0; it < 30; it++) { const x1 = h - GR * (h - l), x2 = l + GR * (h - l); if (dist(props[ti]!, props[j]!, x1) < dist(props[ti]!, props[j]!, x2)) h = x2; else l = x1; }
          const tb = (l + h) / 2, db = dist(props[ti]!, props[j]!, tb);
          const key = [objs[ti]!.noradId, objs[j]!.noradId].sort((x, y) => x - y).join('-');
          if (db < 5 && tb >= t0 && tb <= t1 && !formPairs.has(key)) found.push({ ti, j, d: db, t: tb });
        }
        prev2[k]![j] = b; prev1[k]![j] = d;
      }
    });
  }
  // the same encounter seen from two targets (both in the list) is one event
  const seen = new Set<string>();
  const uniq = found.filter((f) => { const k = [objs[f.ti]!.noradId, objs[f.j]!.noradId].sort((x, y) => x - y).join('-') + '@' + Math.round(f.t / 5000); if (seen.has(k)) return false; seen.add(k); return true; });
  const byPair = new Map<string, number[]>();
  for (const e of ev) { const k = `${e.a}-${e.b}`; (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(e.tca); }
  let matched = 0, maxDt = 0, maxDd = 0;
  const miss: string[] = [];
  for (const f of uniq) {
    const a = objs[f.ti]!.noradId, b = objs[f.j]!.noradId, k = a < b ? `${a}-${b}` : `${b}-${a}`;
    const hit = (byPair.get(k) ?? []).find((t) => Math.abs(t - f.t) < 20_000);
    if (hit !== undefined) {
      matched++; maxDt = Math.max(maxDt, Math.abs(hit - f.t));
      const e = ev.find((x) => `${x.a}-${x.b}` === k && x.tca === hit)!; maxDd = Math.max(maxDd, Math.abs(e.miss - f.d));
    } else miss.push(`${k} ${new Date(f.t).toISOString()} d=${f.d.toFixed(3)}`);
  }
  const tIds = new Set(targets.map((i) => objs[i]!.noradId));
  const inSlice = ev.filter((e) => tIds.has(e.a) || tIds.has(e.b)).length;
  console.log(`RECALL ${day} ${tag}: ${N} objects, ${targets.length} targets (ISS + ${busiest.length} busiest + ${randoms.length} random), brute force every 2 s + golden section over ${meta.hours} h: ${uniq.length} approaches < 5 km; found by the screener ${matched} => recall ${((100 * matched) / Math.max(1, uniq.length)).toFixed(2)}%; max |TCA diff| ${(maxDt / 1000).toFixed(3)} s, max |miss diff| ${maxDd.toFixed(4)} km; screener events involving the targets ${inSlice}; brute force took ${((Date.now() - T) / 1000).toFixed(0)} s`);
  if (miss.length) console.log('MISSING:\n' + miss.join('\n'));
}

if (mode === 'exact') {
  const n = Number(args.get('n') ?? 5);
  const days = ['2026-10-12', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-18'];
  const rnd = rng(2026);
  for (let q = 0; q < n; q++) {
    const day = days[q % days.length]!;
    const ev = gunzipSync(readFileSync(batchFile(day))).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FwdEvent);
    // prefer interesting events: pick among the 300 with the highest Pc, alternate with plain random
    const pool = q % 2 === 0 ? [...ev].sort((x, y) => y.pcBal - x.pcBal).slice(0, 300) : ev;
    const e = pool[Math.floor(rnd() * pool.length)]!;
    const cc = causalCatalog(day);
    const A = cc.objs.find((o) => o.noradId === e.a)!, B = cc.objs.find((o) => o.noradId === e.b)!;
    const sa = satellite.json2satrec(A.omm as never), sb = satellite.json2satrec(B.omm as never);
    const at = (s: typeof sa, t: number) => { const o = satellite.sgp4(s, (t - (s.jdsatepoch - 2440587.5) * 86_400_000) / 60_000); return o as { position: P3; velocity: P3 }; };
    let best = Infinity, bt = e.tca;
    for (let t = e.tca - 20_000; t <= e.tca + 20_000; t += 10) { const a = at(sa, t), b = at(sb, t); const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z); if (d < best) { best = d; bt = t; } }
    const a = at(sa, bt), b = at(sb, bt);
    const vrel = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y, a.velocity.z - b.velocity.z);
    // --- Pc rebuilt independently: own RIC vectors, own plane, polar integral ---
    const unit = (v: number[]) => { const m = Math.hypot(v[0]!, v[1]!, v[2]!); return v.map((x) => x / m); };
    const crs = (u: number[], v: number[]) => [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const dt = (u: number[], v: number[]) => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
    const ric = (s: { position: P3; velocity: P3 }) => { const r = unit([s.position.x, s.position.y, s.position.z]); const c = unit(crs([s.position.x, s.position.y, s.position.z], [s.velocity.x, s.velocity.y, s.velocity.z])); return [r, crs(c, r), c]; };
    const rel = [b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z];
    const w = unit([b.velocity.x - a.velocity.x, b.velocity.y - a.velocity.y, b.velocity.z - a.velocity.z]);
    const pm = rel.map((x, i) => x - dt(rel, w) * w[i]!);
    const e1 = unit(pm), e2 = crs(w, e1);
    const objLike = (c: typeof A) => ({ noradId: c.noradId, regime: c.regime, objectType: (c as unknown as { objectType?: string }).objectType, perigee: c.perigee, bstar: Number(c.omm.BSTAR) });
    const covPlane = (cons: boolean, floor: boolean) => {
      let xx = 0, xy = 0, yy = 0;
      for (const [s, c, age] of [[a, A, (bt - epochMsOf(A.omm)) / 86_400_000], [b, B, (bt - epochMsOf(B.omm)) / 86_400_000]] as const) {
        let sg = sigmaRIC(objLike(c), age, undefined, cons);
        if (floor) sg = floorSigma(sg);
        const ax = ric(s);
        for (let k = 0; k < 3; k++) { const u1 = dt(ax[k]!, e1), u2 = dt(ax[k]!, e2), v = sg[k]! ** 2; xx += v * u1 * u1; xy += v * u1 * u2; yy += v * u2 * u2; }
      }
      return { xx, xy, yy };
    };
    const hbr = hardBodyRadiusKm(A as never) + hardBodyRadiusKm(B as never);
    const polar = (m1: number, cv: { xx: number; xy: number; yy: number }, R: number) => {
      const det = cv.xx * cv.yy - cv.xy ** 2, ixx = cv.yy / det, ixy = -cv.xy / det, iyy = cv.xx / det;
      const nr = 400, nt = 1200; let s = 0;
      for (let i = 0; i < nr; i++) { const r = ((i + 0.5) / nr) * R; for (let j = 0; j < nt; j++) { const th = ((j + 0.5) / nt) * 2 * Math.PI; const dx = r * Math.cos(th) - m1, dy = r * Math.sin(th); s += Math.exp(-0.5 * (ixx * dx * dx + 2 * ixy * dx * dy + iyy * dy * dy)) * r; } }
      return (s * (R / nr) * (2 * Math.PI) / nt) / (2 * Math.PI * Math.sqrt(det));
    };
    const m1 = Math.hypot(pm[0]!, pm[1]!, pm[2]!);
    const pBal = polar(m1, covPlane(false, true), hbr), pCons = polar(m1, covPlane(true, true), hbr), pNo = polar(m1, covPlane(false, false), hbr);
    console.log(`EXACT ${day} ${e.nameA} (${e.a}) / ${e.nameB} (${e.b}): stored miss ${e.miss.toFixed(6)} km at ${new Date(e.tca).toISOString()}, v ${e.vrel.toFixed(3)}; recomputed (10 ms scan) miss ${best.toFixed(6)} km at ${new Date(bt).toISOString()}, v ${vrel.toFixed(3)}; |dmiss| ${Math.abs(best - e.miss).toFixed(6)} km, |dt| ${(Math.abs(bt - e.tca) / 1000).toFixed(3)} s | Pc stored/recomputed: balanced ${e.pcBal.toExponential(4)} / ${pBal.toExponential(4)}, conservative ${e.pcCons.toExponential(4)} / ${pCons.toExponential(4)}, no-floor ${e.pcBalNoFloor.toExponential(4)} / ${pNo.toExponential(4)}`);
  }
}
