// ============================================================
// SPIKE — not production. Browser pack (P5): the Node side of the agreement test.
//
// Answers the same questions as the browser worker, but from the ORIGINAL files with the older spike code
// (tle-cache.json -> runs.ts makeProp/posAt, coverage-lib subPoint/inPoly/INDIA_POLY, coverage-codec on
// data/coverage/<day>.day.bin, history catalog json), then compares with the browser results file.
//   npx tsx packages/backend/scripts/starmap/pack-verify.ts <browser-results.json> [--label main]
// Pass criteria: same object lists exactly; every position within 1 m (we report the largest difference).
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadCatalog, parseArgs } from './catalog.js';
import { makeProp, posAt, newStats, windowInCap } from './runs.js';
import { INDIA_POLY, subPoint, inPoly, COVERAGE_DIR, HISTORY_DIR } from './coverage-lib.js';
import { readCoverage, findCell, forEachId, GRAN_DAY } from './coverage-codec.js';
import { makeSat, sgp4Burst } from './pack-query.js';
import { rowFromCatalog } from './pack-format.js';

const DATA = fileURLToPath(new URL('../../data/', import.meta.url));
const args = parseArgs(process.argv.slice(2));
const resultsPath = process.argv[2]!;
const R = JSON.parse(readFileSync(resultsPath, 'utf8'));
const T0 = R.meta.tMs as number;
const liveFile = (R.meta.liveFile as string | undefined) ?? DATA + 'tle-cache.json';

const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const out: Record<string, unknown> = {};
let allOk = true;
const check = (name: string, ok: boolean, detail: string): void => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); if (!ok) allOk = false; out[name] = { ok, detail }; };

// ---- Node truth: independent code path
const cat = loadCatalog(liveFile);
const props = new Map<number, NonNullable<ReturnType<typeof makeProp>>>();
for (const o of cat) { const p = makeProp(o.omm); if (p) props.set(o.noradId, p); }

// Q1 India now
let t = process.hrtime.bigint();
const st = newStats();
const nodeHits: Array<{ norad: number; lat: number; lon: number; x: number; y: number; z: number }> = [];
for (const [norad, p] of props) {
  if (!windowInCap(p, T0, T0)) continue;
  const pos = posAt(p, T0, st);
  if (!pos) continue;
  const sp = subPoint(pos.x, pos.y, pos.z, T0);
  if (inPoly(sp.latDeg, sp.lonDeg, INDIA_POLY)) nodeHits.push({ norad, lat: sp.latDeg, lon: sp.lonDeg, x: pos.x, y: pos.y, z: pos.z });
}
const nodeIndiaMs = Number(process.hrtime.bigint() - t) / 1e6;
nodeHits.sort((a, b) => a.norad - b.norad);
{
  const b = R.queries.india.result as { hits: Array<{ norad: number; latDeg: number; lonDeg: number; x: number; y: number; z: number }> };
  const sameIds = b.hits.length === nodeHits.length && b.hits.every((h, i) => h.norad === nodeHits[i]!.norad);
  let maxM = 0;
  if (sameIds) for (let i = 0; i < b.hits.length; i++) { const h = b.hits[i]!, n = nodeHits[i]!; maxM = Math.max(maxM, 1000 * Math.hypot(h.x - n.x, h.y - n.y, h.z - n.z)); }
  check('india-now', sameIds && maxM < 1, `${nodeHits.length} objects over India in Node, ${b.hits.length} in browser; same list: ${sameIds}; max position difference ${maxM.toExponential(2)} m`);
  out.indiaCount = nodeHits.length; out.indiaMaxM = maxM;
  const set = new Set(nodeHits.map((h) => h.norad));
  console.log(`      (Node SGP4 calls: ${st.propCalls}, failed ${st.noCell}; sample hit ids ${[...set].slice(0, 5).join(',')})`);
}

// Q2 ISS path 24 h at 10 s
t = process.hrtime.bigint();
const iss = props.get(25544)!;
const n = Math.floor((24 * 3600) / 10) + 1;
const nodeT = new Float64Array(n * 3), nodeLat = new Float64Array(n), nodeLon = new Float64Array(n);
const st2 = newStats();
for (let i = 0; i < n; i++) {
  const tm = T0 + i * 10_000;
  const p = posAt(iss, tm, st2)!;
  nodeT[i * 3] = p.x; nodeT[i * 3 + 1] = p.y; nodeT[i * 3 + 2] = p.z;
  const sp = subPoint(p.x, p.y, p.z, tm); nodeLat[i] = sp.latDeg; nodeLon[i] = sp.lonDeg;
}
const nodeIssMs = Number(process.hrtime.bigint() - t) / 1e6;
{
  const b = R.queries.iss.result as { n: number; teme: number[]; lat: number[]; lon: number[]; failed: number };
  let maxM = 0, maxDeg = 0;
  for (let i = 0; i < n; i++) {
    maxM = Math.max(maxM, 1000 * Math.hypot(b.teme[i * 3]! - nodeT[i * 3]!, b.teme[i * 3 + 1]! - nodeT[i * 3 + 1]!, b.teme[i * 3 + 2]! - nodeT[i * 3 + 2]!));
    maxDeg = Math.max(maxDeg, Math.abs(b.lat[i]! - nodeLat[i]!), Math.abs(b.lon[i]! - nodeLon[i]!));
  }
  check('iss-24h', b.n === n && b.failed === 0 && maxM < 1, `${n} samples; max TEME position difference ${maxM.toExponential(2)} m; max lat/lon difference ${maxDeg.toExponential(2)} deg`);
  out.issMaxM = maxM;
}

// Q3 box on pack days
const day = R.meta.boxDay as string, order = R.meta.boxOrder as number, cell = R.meta.boxCell as number;
function nodeBox(d: string): number[] {
  const cov = readCoverage(new Uint8Array(readFileSync(COVERAGE_DIR + `${d}.day.bin`)));
  const cfg = cov.configs.find((c) => c.gran === GRAN_DAY && c.order === order)!;
  const i = findCell(cfg, cell);
  const ids: number[] = [];
  if (i >= 0) forEachId(cov.buf, cfg.offs[i]!, cfg.lens[i]!, cfg.tags[i]!, (id) => ids.push(cov.norad[id]!));
  return ids.sort((a, b) => a - b);
}
t = process.hrtime.bigint();
const nb = nodeBox(day);
const nodeBoxMs = Number(process.hrtime.bigint() - t) / 1e6;
{
  const b = R.queries.box.result as { norads: number[]; count: number };
  const same = b.count === nb.length && b.norads.every((x, i) => x === nb[i]);
  check('box-9138-day', same, `${day} order ${order} box ${cell}: ${nb.length} objects in Node, ${b.count} in browser; identical: ${same}`);
  out.boxCount = nb.length;
}
if (R.queries.boxAll) {
  const b = R.queries.boxAll.result as { per: Array<{ day: string; count: number }>; union: number };
  const uni = new Set<number>(); let ok = true;
  for (const p of b.per) { const ids = nodeBox(p.day); if (ids.length !== p.count) ok = false; for (const x of ids) uni.add(x); }
  check('box-9138-all-pack-days', ok && uni.size === b.union, `${b.per.length} days, per-day counts equal: ${ok}; union ${uni.size} (Node) vs ${b.union} (browser)`);
}

// Bonus: a past day's catalog rebuilt in the browser from element-set chunks equals the real history file
if (R.queries.dayCatalog) {
  const b = R.queries.dayCatalog.result as { day: string; count: number; digest: string };
  const hc = loadCatalog(HISTORY_DIR + `catalog-${b.day}.json`).slice().sort((x, y) => x.noradId - y.noradId);
  const text = hc.map((o) => o.noradId + '|' + String(o.omm.EPOCH)).join('\n');
  const digest = createHash('sha256').update(text).digest('hex');
  check('day-catalog-rebuild', hc.length === b.count && digest === b.digest, `${b.day}: ${hc.length} objects in history file, ${b.count} rebuilt in browser from pack chunks; digests equal: ${digest === b.digest}`);
}

// Node timings + SGP4 speed with the very same burst function
const sats = cat.map((o) => makeSat(rowFromCatalog(o, true))).filter((s): s is NonNullable<typeof s> => !!s);
sgp4Burst(sats.slice(0, 2000), T0, 1, () => performance.now());
let calls = 0, ms = 0, pass = 0;
while (ms < 2000) { const r = sgp4Burst(sats, T0 + pass * 600_000, 1, () => performance.now()); calls += r.calls; ms += r.ms; pass++; }
const nodeSpeed = (calls / ms) * 1000;
const bw = R.bench as { callsPerSec: number } | undefined;
console.log(`\nNode timings (older code path, one thread): India ${nodeIndiaMs.toFixed(1)} ms, ISS ${nodeIssMs.toFixed(1)} ms, box ${nodeBoxMs.toFixed(1)} ms (incl. file read)`);
console.log(`SGP4 speed, same loop: Node ${(nodeSpeed / 1e6).toFixed(2)} M calls/s${bw ? `, browser worker ${(bw.callsPerSec / 1e6).toFixed(2)} M calls/s (ratio ${(bw.callsPerSec / nodeSpeed).toFixed(2)})` : ''}`);
out.node = { indiaMs: nodeIndiaMs, issMs: nodeIssMs, boxMs: nodeBoxMs, sgp4CallsPerSec: nodeSpeed };
const qm = (k: string): number | null => (R.queries[k]?.runs ? med(R.queries[k].runs.map((x: { ms: number }) => x.ms)) : null);
console.log(`Browser median query times (worker, ms): India ${qm('india')?.toFixed(1)}, ISS ${qm('iss')?.toFixed(1)}, box ${qm('box')?.toFixed(2)}`);
console.log(allOk ? '\nAGREEMENT: ALL PASS' : '\nAGREEMENT: FAILURES');
writeFileSync(resultsPath.replace(/\.json$/, '') + '.verify.json', JSON.stringify(out, null, 1));
void args;
process.exit(allOk ? 0 : 1);
