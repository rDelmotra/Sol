// ============================================================
// SPIKE — not production. Q-L3: the "orbit-shape shortcut" (predict who can pass over India / through box B
// from the element set alone, no summaries, no SGP4) versus the truth.
//
//   npx tsx packages/backend/scripts/starmap/coverage-shortcut.ts
//
// Needs: coverage-query.ts --stage truth (truth days) and --stage query (per-day answers) already run.
//  India : can the orbit reach India's latitudes (max latitude = i or 180-i)? GEO-like objects also need
//          their longitude near India's.
//  Box B : height band (perigee/apogee vs the box's shell) and latitude band; "plane" adds: is the box's
//          direction near the orbit plane at some hour of the day.
// Reported per regime: false negatives (real passes the shortcut would drop) and false positives.
// ============================================================
import { readFileSync, existsSync } from 'node:fs';
import { cellCentre, decodeKey, pix2angNest, SHELL_DELTA0, WGS84_A_KM, DEG, RAD } from '@orbitwatch/orbital-core';
import * as satellite from 'satellite.js';
import { loadCatalog, parseArgs, type CatObj } from './catalog.js';
import { dailyDays, COVERAGE_DIR, DAY_MS, FENCED, subPoint, POLY_LAT_MIN, POLY_LON_MIN, POLY_LON_MAX } from './coverage-lib.js';
import { makeProp } from './runs.js';

const a = parseArgs(process.argv.slice(2));
const days = dailyDays().slice(-Number(a.get('ndays') ?? 29));
const Q_DIR = COVERAGE_DIR + 'q/';
const log = (...x: unknown[]) => console.log(...x);
const bx = JSON.parse(readFileSync(Q_DIR + 'box.json', 'utf8')) as { key: number; rLo: number; rHi: number };

interface Box { key: number; rLo: number; rHi: number; zMin: number; zMax: number; halfWidthDeg: number; centre: { x: number; y: number; z: number } }
function boxInfo(): Box {
  const { pix } = decodeKey(3, bx.key);
  let zMin = 2, zMax = -2, hw = 0; const cen = pix2angNest(3, pix);
  const cs = Math.sqrt(1 - cen.z * cen.z), cd = [cs * Math.cos(cen.phi), cs * Math.sin(cen.phi), cen.z];
  for (let q = 0; q < 4 ** 4; q++) {
    const s = pix2angNest(7, pix * 4 ** 4 + q), ss = Math.sqrt(1 - s.z * s.z);
    zMin = Math.min(zMin, s.z); zMax = Math.max(zMax, s.z);
    hw = Math.max(hw, Math.acos(Math.min(1, cd[0]! * ss * Math.cos(s.phi) + cd[1]! * ss * Math.sin(s.phi) + cd[2]! * s.z)));
  }
  return { key: bx.key, rLo: bx.rLo, rHi: bx.rHi, zMin, zMax, halfWidthDeg: hw * DEG, centre: cellCentre(3, bx.key) };
}
const box = boxInfo();
void SHELL_DELTA0; void WGS84_A_KM;

const MU = 398600.4418, J2 = 1.08262668e-3, RE = 6378.137;
interface El { inc: number; raan: number; e: number; nRevDay: number; a: number; rp: number; ra: number; epochMs: number }
function elOf(o: CatObj): El | null {
  const m = o.omm as Record<string, number | string>;
  const n = Number(m.MEAN_MOTION), e = Number(m.ECCENTRICITY), inc = Number(m.INCLINATION), raan = Number(m.RA_OF_ASC_NODE);
  if (!(n > 0)) return null;
  const aa = Math.cbrt(MU / ((n * 2 * Math.PI / 86400) ** 2));
  return { inc, raan, e, nRevDay: n, a: aa, rp: aa * (1 - e), ra: aa * (1 + e), epochMs: Date.parse(String(m.EPOCH)) };
}
const maxLat = (inc: number) => (inc <= 90 ? inc : 180 - inc);
const isGeoLike = (el: El) => Math.abs(el.nRevDay - 1.0027) < 0.02 && el.e < 0.01;
function shortcutIndia(el: El, lonDay: number | null): boolean {
  if (maxLat(el.inc) + 0.5 < POLY_LAT_MIN) return false;
  if (isGeoLike(el)) {
    if (lonDay === null) return true;
    const m = 5;
    return lonDay >= POLY_LON_MIN - m && lonDay <= POLY_LON_MAX + m;
  }
  return true;
}
const PAD_KM = 30, LAT_PAD = 0.5, PLANE_PAD_DEG = 1.0;
function shortcutBoxBand(el: El): boolean {
  if (el.rp - PAD_KM > box.rHi || el.ra + PAD_KM < box.rLo) return false;
  const mL = maxLat(el.inc) + LAT_PAD;
  const dMin = Math.asin(box.zMin) * DEG, dMax = Math.asin(box.zMax) * DEG;
  const dist = dMin <= 0 && dMax >= 0 ? 0 : Math.min(Math.abs(dMin), Math.abs(dMax));
  return dist <= mL;
}
function shortcutBoxPlane(el: El, dayStartMs: number): boolean {
  const p = el.a * (1 - el.e * el.e), n = el.nRevDay * 2 * Math.PI / 86400;
  const rate = -1.5 * J2 * (RE / p) ** 2 * n * Math.cos(el.inc * RAD);
  const c = box.centre, cr = Math.hypot(c.x, c.y, c.z);
  const d = [c.x / cr, c.y / cr, c.z / cr];
  const lim = Math.sin((box.halfWidthDeg + PLANE_PAD_DEG) * RAD);
  const si = Math.sin(el.inc * RAD), ci = Math.cos(el.inc * RAD);
  for (let h = 0; h <= 24; h += 1) {
    const raan = el.raan * RAD + rate * ((dayStartMs + h * 3600_000 - el.epochMs) / 1000);
    const nx = si * Math.sin(raan), ny = -si * Math.cos(raan), nz = ci;
    if (Math.abs(d[0]! * nx + d[1]! * ny + d[2]! * nz) <= lim) return true;
  }
  return false;
}

const regimes = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];
type Cell = { tp: number; fn: number; fp: number; tn: number };
type Tab = Record<string, Cell>;
const mk = (): Tab => Object.fromEntries([...regimes, 'ALL'].map((r) => [r, { tp: 0, fn: 0, fp: 0, tn: 0 }]));
const add = (t: Tab, reg: string, pred: boolean, tr: boolean) => {
  for (const k of [reg, 'ALL']) { const c = t[k]!; if (pred && tr) c.tp++; else if (!pred && tr) c.fn++; else if (pred && !tr) c.fp++; else c.tn++; }
};
const print = (name: string, t: Tab) => {
  log(`-- ${name}`);
  log('   regime   truth+  FN     FP      TN   recall   precision');
  for (const r of [...regimes, 'ALL']) {
    const c = t[r]!; const pos = c.tp + c.fn;
    if (pos + c.fp + c.tn === 0) continue;
    log(`   ${r.padEnd(6)} ${String(pos).padStart(7)} ${String(c.fn).padStart(3)} ${String(c.fp).padStart(6)} ${String(c.tn).padStart(7)}   ${pos ? (100 * c.tp / pos).toFixed(2) + '%' : 'n/a'}   ${c.tp + c.fp ? (100 * c.tp / (c.tp + c.fp)).toFixed(1) + '%' : 'n/a'}`);
  }
};

function loadU16(path: string): Uint16Array { const b = readFileSync(path); return new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); }
function positives(q: string, day: string): Set<number> {
  const f = `${Q_DIR}refine-${q}-${day}.json`;
  return new Set((JSON.parse(readFileSync(f, 'utf8')) as Array<[number, number[]]>).map((r) => r[0]));
}

const T = { indObjDayTruth: mk(), indObjTruth: mk(), indObjDayAns: mk(), indObjAns: mk(), band: mk(), plane: mk(), bandDay: mk(), planeDay: mk(), bandAns: mk(), planeAns: mk(), bandAnsDay: mk(), planeAnsDay: mk() };
type Agg = { reg: string; shI: boolean; trI: boolean; ansI: boolean; shI_t: boolean; shBand: boolean; shPlane: boolean; ansB: boolean; shBand_t: boolean; shPlane_t: boolean; trB: boolean };
const agg = new Map<number, Agg>();
let truthDays = 0;
for (const d of days) {
  const cat = loadCatalog(d.path);
  const ti = `${Q_DIR}truth-${d.day}-${box.key}.json`;
  const hasT = existsSync(ti);
  if (hasT) truthDays++;
  const tI = hasT ? loadU16(`${Q_DIR}truth-${d.day}-${box.key}.india`) : null, tB = hasT ? loadU16(`${Q_DIR}truth-${d.day}-${box.key}.box`) : null;
  const pI = positives('india', d.day), pB = positives('box', d.day);
  for (let i = 0; i < cat.length; i++) {
    const o = cat[i]!; if (FENCED.has(o.noradId)) continue;
    const el = elOf(o); if (!el) continue;
    let lonDay: number | null = null;
    if (isGeoLike(el) && maxLat(el.inc) + 0.5 >= POLY_LAT_MIN) {
      const p = makeProp(o.omm);
      const pv = p ? satellite.sgp4(p.satrec, (d.startMs + DAY_MS / 2 - p.epochMs) / 60000) : null;
      if (pv && pv.position && typeof pv.position !== 'boolean') lonDay = subPoint(pv.position.x, pv.position.y, pv.position.z, d.startMs + DAY_MS / 2).lonDeg;
    }
    const sh = shortcutIndia(el, lonDay), band = shortcutBoxBand(el), plane = band && shortcutBoxPlane(el, d.startMs);
    add(T.indObjDayAns, o.regime, sh, pI.has(i)); add(T.bandAnsDay, o.regime, band, pB.has(i)); add(T.planeAnsDay, o.regime, plane, pB.has(i));
    let g = agg.get(o.noradId);
    if (!g) { g = { reg: o.regime, shI: false, trI: false, ansI: false, shI_t: false, shBand: false, shPlane: false, ansB: false, shBand_t: false, shPlane_t: false, trB: false }; agg.set(o.noradId, g); }
    g.shI ||= sh; g.ansI ||= pI.has(i); g.shBand ||= band; g.shPlane ||= plane; g.ansB ||= pB.has(i);
    if (hasT) {
      add(T.indObjDayTruth, o.regime, sh, tI![i]! > 0); add(T.bandDay, o.regime, band, tB![i]! > 0); add(T.planeDay, o.regime, plane, tB![i]! > 0);
      g.shI_t ||= sh; g.trI ||= tI![i]! > 0; g.shBand_t ||= band; g.shPlane_t ||= plane; g.trB ||= tB![i]! > 0;
    }
  }
}
const withT = [...agg.values()].filter((g) => g.shI_t || g.trI || g.shBand_t || g.trB || true);
void withT;
for (const g of agg.values()) {
  add(T.indObjAns, g.reg, g.shI, g.ansI); add(T.bandAns, g.reg, g.shBand, g.ansB); add(T.planeAns, g.reg, g.shPlane, g.ansB);
  add(T.indObjTruth, g.reg, g.shI_t, g.trI); add(T.band, g.reg, g.shBand_t, g.trB); add(T.plane, g.reg, g.shPlane_t, g.trB);
}
log(`Q-L3 over ${days.length} days (${days[0]!.day}..${days[days.length - 1]!.day}), truth days with brute force: ${truthDays}; box B key ${box.key}`);
print('India, per object-day, vs ANSWER (summaries+refine, all days)', T.indObjDayAns);
print('India, per object (any day), vs ANSWER (all days)', T.indObjAns);
if (truthDays) { print(`India, per object-day, vs TRUTH (${truthDays} d)`, T.indObjDayTruth); print(`India, per object, vs TRUTH (${truthDays} d)`, T.indObjTruth); }
print('Box B band (height+latitude), per object-day, vs ANSWER', T.bandAnsDay);
print('Box B band+plane, per object-day, vs ANSWER', T.planeAnsDay);
print('Box B band, per object (any day), vs ANSWER', T.bandAns);
print('Box B band+plane, per object (any day), vs ANSWER', T.planeAns);
if (truthDays) {
  print(`Box B band, per object-day, vs TRUTH (${truthDays} d)`, T.bandDay);
  print(`Box B band+plane, per object-day, vs TRUTH (${truthDays} d)`, T.planeDay);
  print(`Box B band, per object, vs TRUTH (${truthDays} d)`, T.band);
  print(`Box B band+plane, per object, vs TRUTH (${truthDays} d)`, T.plane);
}
