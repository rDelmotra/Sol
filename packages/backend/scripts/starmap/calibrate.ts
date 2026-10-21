// ============================================================
// SPIKE — not production.
//
// Pad calibration. Mean-element perigee/apogee and the mean ellipse are NOT exactly where SGP4
// puts the object (short-period J2 terms, drag, Kozai vs Brouwer mean motion). For a stratified
// sample, propagate with SGP4 and record, per object, the largest
//   below : how far the SGP4 radius dips below the mean perigee radius
//   above : how far it rises above the mean apogee radius
//   ell   : distance from the SGP4 position to the nearest point of the (J2-drifting) mean ellipse
// then report p50/p99/max per regime. The sieves use pads >= the max.
//
//   npx tsx packages/backend/scripts/starmap/calibrate.ts [--start 2026-10-20T01:00:00Z] [--hours 6] [--step 10]
//      [--leo 300 --meo 60 --geo 60 --heo 60] [--all] [--out /tmp/starmap/pads.json]
// ============================================================

import { writeFileSync } from 'node:fs';
import * as satellite from 'satellite.js';
import { loadCatalog, parseArgs, rng } from './catalog.js';
import { makeProp } from './runs.js';
import { elementsFromOmm } from './invariants.js';
import { wireFromElements, distToWire } from './moid.js';

const a = parseArgs(process.argv.slice(2));
const START = Date.parse(a.get('start') ?? '2026-10-20T01:00:00Z');
const HOURS = Number(a.get('hours') ?? 6);
const STEP = Number(a.get('step') ?? (a.has('all') ? 60 : 10)) * 1000;
const want: Record<string, number> = { LEO: Number(a.get('leo') ?? 300), MEO: Number(a.get('meo') ?? 60), GEO: Number(a.get('geo') ?? 60), HEO: Number(a.get('heo') ?? 60) };
const OUT = a.get('out') ?? (a.has('all') ? '/tmp/starmap/pads-all.json' : '/tmp/starmap/pads.json');

const cat = loadCatalog();
const r = rng(20261020);
const chosen: typeof cat = [];
if (a.has('all')) chosen.push(...cat);
else {
  for (const reg of Object.keys(want)) {
    const pool = cat.filter((o) => o.regime === reg);
    for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [pool[k], pool[j]] = [pool[j]!, pool[k]!]; }
    chosen.push(...pool.slice(0, want[reg]!));
  }
}

interface Per { reg: string; norad: number; below: number; above: number; ell: number }
const per: Per[] = [];
const t0 = Date.now();
let skipped = 0;
for (const o of chosen) {
  const el = elementsFromOmm(o.noradId, o.omm);
  const p = makeProp(o.omm);
  if (!el || !p) { skipped++; continue; }
  let below = 0, above = 0, ell = 0, ok = 0;
  const w = new Float64Array(9);
  for (let t = START; t <= START + HOURS * 3_600_000; t += STEP) {
    const pv = satellite.sgp4(p.satrec, (t - p.epochMs) / 60_000);
    const pos = pv ? pv.position : null;
    if (!pos || typeof pos === 'boolean' || !Number.isFinite(pos.x)) continue;
    ok++;
    const rr = Math.hypot(pos.x, pos.y, pos.z);
    below = Math.max(below, el.rp - rr);
    above = Math.max(above, rr - el.ra);
    wireFromElements(el, t, w);
    ell = Math.max(ell, distToWire(w, pos.x, pos.y, pos.z));
  }
  if (ok === 0) { skipped++; continue; }
  per.push({ reg: o.regime, norad: o.noradId, below, above, ell });
}
const q = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const pads: Record<string, { n: number; below: number; above: number; ell: number; p99: { below: number; above: number; ell: number } }> = {};
console.log(`window ${new Date(START).toISOString()} + ${HOURS} h, step ${STEP / 1000}s; objects ${per.length} (skipped ${skipped}); ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log('regime  n    | below-perigee km p50/p99/max | above-apogee km p50/p99/max | dist-to-mean-ellipse km p50/p99/max');
for (const reg of ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']) {
  const xs = per.filter((x) => x.reg === reg);
  if (!xs.length) continue;
  const f = (k: 'below' | 'above' | 'ell') => { const v = xs.map((x) => Math.max(0, x[k])); return [q(v, 0.5), q(v, 0.99), Math.max(...v)]; };
  const [b, ab, e] = [f('below'), f('above'), f('ell')];
  const fmt = (v: number[]) => v.map((x) => x.toFixed(2)).join(' / ');
  console.log(`${reg.padEnd(6)} ${String(xs.length).padStart(5)} | ${fmt(b!)} | ${fmt(ab!)} | ${fmt(e!)}`);
  pads[reg] = { n: xs.length, below: b![2]!, above: ab![2]!, ell: e![2]!, p99: { below: b![1]!, above: ab![1]!, ell: e![1]! } };
  const worst = [...xs].sort((x, y) => y.ell - x.ell)[0]!;
  console.log(`        worst ellipse-distance object: ${worst.norad} ${worst.ell.toFixed(2)} km`);
}
writeFileSync(OUT, JSON.stringify(pads, null, 1));
if (a.has('all')) {
  // per-object maxima: the screeners use this to flag objects that exceed their regime pad ("wild")
  writeFileSync('/tmp/starmap/pads-objects.json', JSON.stringify(Object.fromEntries(per.map((x) => [x.norad, [x.below, x.above, x.ell]]))));
}
console.log(`max values written to ${OUT}`);
