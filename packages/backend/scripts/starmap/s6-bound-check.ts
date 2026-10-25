// ============================================================
// SPIKE — not production. Checks the acceleration assumption of THE BOUND (s6-lib.ts) on real catalog pairs:
//   npx tsx packages/backend/scripts/starmap/s6-bound-check.ts <day> <tag> [--n 4000] [--dt 60]
// For random events of an S6 batch, takes the relative state at a random time up to dt/2 away from the closest approach, extrapolates it
// linearly to the closest approach, and compares the actual error with eps = a_max h^2 / 2 as the screener computes it. Prints the largest ratio.
// ============================================================
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as satellite from 'satellite.js';
import { parseArgs, rng } from './catalog.js';
import { makeProp } from './runs.js';
import { batchFile, readLines } from './forward-common.js';
import { causalCatalog, type FwdEvent } from './forward-lib.js';
import { maxSeparation, relAccelBound } from './s6-lib.js';

const args = parseArgs(process.argv.slice(4));
const day = process.argv[2]!, tag = process.argv[3]!;
const n = Number(args.get('n') ?? 4000), dtS = Number(args.get('dt') ?? 60), h = dtS / 2;
const ev = readLines(batchFile(day, tag)).map((l) => JSON.parse(l) as FwdEvent);
const cc = causalCatalog(day), by = new Map(cc.objs.map((o) => [o.noradId, makeProp(o.omm)]));
const rnd = rng(9);
const st = (p: NonNullable<ReturnType<typeof makeProp>>, t: number) => { const o = satellite.sgp4(p.satrec, (t - p.epochMs) / 60_000) as { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number } }; return o; };
let worst = 0, worstAt = '', k = 0, over = 0;
const ratios: number[] = [];
while (k < n) {
  const e = ev[Math.floor(rnd() * ev.length)]!;
  const pa = by.get(e.a), pb = by.get(e.b);
  if (!pa || !pb) continue;
  const tau = (rnd() * 2 - 1) * h, t = e.tca - tau * 1000;
  const a = st(pa, t), b = st(pb, t), a2 = st(pa, e.tca), b2 = st(pb, e.tca);
  const r = [b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z], w = [b.velocity.x - a.velocity.x, b.velocity.y - a.velocity.y, b.velocity.z - a.velocity.z];
  const pred = r.map((x, i) => x + w[i]! * tau), act = [b2.position.x - a2.position.x, b2.position.y - a2.position.y, b2.position.z - a2.position.z];
  const err = Math.hypot(pred[0]! - act[0]!, pred[1]! - act[1]!, pred[2]! - act[2]!);
  const rad = Math.min(Math.hypot(a.position.x, a.position.y, a.position.z), Math.hypot(b.position.x, b.position.y, b.position.z));
  const rf = rad - 15 * h, rn = Math.hypot(r[0]!, r[1]!, r[2]!), wn = Math.hypot(w[0]!, w[1]!, w[2]!);
  const eps = 0.5 * relAccelBound(maxSeparation(rn, wn, h, rf), rf) * Math.abs(tau) ** 2;
  if (eps <= 0) continue;
  const ratio = err / eps; ratios.push(ratio); k++;
  if (ratio > worst) { worst = ratio; worstAt = `${e.nameA} / ${e.nameB} tau ${tau.toFixed(1)} s err ${err.toFixed(4)} km eps ${eps.toFixed(4)} km`; }
  if (ratio > 1) over++;
}
ratios.sort((x, y) => x - y);
console.log(`BOUND CHECK ${day} ${tag}: ${n} real events, window half ${h} s: error/eps median ${ratios[n >> 1]!.toFixed(4)}, p99 ${ratios[Math.floor(n * 0.99)]!.toFixed(4)}, max ${worst.toFixed(4)} (${worstAt}); cases above 1: ${over}`);
