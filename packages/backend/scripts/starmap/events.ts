// ============================================================
// SPIKE — not production.
//
// "Layer 3": derived events computed once per day and kept forever (FABRIC.md B6/B7).
// Shared library: region geometry, catalog diffing (appeared / disappeared / elements.jump),
// event row type and the Postgres writer. Used by derive-day.ts, events-worker.ts, events-queries.ts.
// ============================================================
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as satellite from 'satellite.js';
import { gmst, temeToEcef, geodeticLatAltFromEr, ER_KM } from '@orbitwatch/orbital-core';
import { makeProp, type Prop } from './runs.js';
import type { CatObj } from './catalog.js';
import { INDIA_POLY } from './coverage-lib.js';
import { NEAR_SHIFT } from './events-region.js';

export const DB_URL = process.env.STARMAP_DB ?? 'postgres://orbitwatch:orbitwatch@localhost:5432/orbitwatch';
export const HISTORY_DIR = fileURLToPath(new URL('../../data/history/', import.meta.url));
export const EVENTS_DIR = fileURLToPath(new URL('../../data/events/', import.meta.url));
export const DAY_MS = 86_400_000;
const DEG = 180 / Math.PI;
const MU = 398600.4418;

export const KINDS = ['object.appeared', 'object.disappeared', 'elements.jump', 'close.approach', 'close.formation', 'region.pass'] as const;
export type Kind = (typeof KINDS)[number];

export interface EventRow {
  kind: Kind;
  subjects: number[];
  tStart: number; // UTC ms
  tEnd: number;
  payload: Record<string, unknown>;
}

// ---------------- catalog files ----------------
export interface CatFull extends CatObj {
  launchDate?: string;
  perigee?: number;
  apogee?: number;
  omm: Record<string, unknown>;
}

/** Contiguous daily catalogs (>= 30k objects), sorted. */
export function contiguousDays(): string[] {
  const days = readdirSync(HISTORY_DIR).filter((f) => /^catalog-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(8, 18)).sort();
  return days.filter((d) => d >= '2026-09-20');
}
export const dayStartMs = (day: string): number => Date.parse(day + 'T00:00:00Z');
export const prevDay = (day: string): string => new Date(dayStartMs(day) - DAY_MS).toISOString().slice(0, 10);
export function loadDayCatalog(day: string): CatFull[] {
  return JSON.parse(readFileSync(HISTORY_DIR + `catalog-${day}.json`, 'utf8')) as CatFull[];
}
export const epochMsOf = (omm: Record<string, unknown>): number => {
  const s = String(omm.EPOCH);
  return Date.parse(s.endsWith('Z') ? s : s + 'Z');
};
/** Identical-element-set key (the objects sit on top of each other: ISS stack etc.). */
export function elsetKey(omm: Record<string, unknown>): string {
  return [omm.EPOCH, omm.MEAN_MOTION, omm.ECCENTRICITY, omm.INCLINATION, omm.RA_OF_ASC_NODE, omm.ARG_OF_PERICENTER, omm.MEAN_ANOMALY, omm.BSTAR].join('|');
}
/** Group id per object index for identical element sets (-1 = unique). */
export function identicalGroups(objs: Array<{ omm: Record<string, unknown> }>): { group: Int32Array; groups: number[][] } {
  const group = new Int32Array(objs.length).fill(-1);
  const by = new Map<string, number[]>();
  objs.forEach((o, i) => { const k = elsetKey(o.omm); (by.get(k) ?? by.set(k, []).get(k)!).push(i); });
  const groups: number[][] = [];
  for (const g of by.values()) if (g.length > 1) { g.forEach((i) => (group[i] = groups.length)); groups.push(g); }
  return { group, groups };
}

// ---------------- regions ----------------
export interface RegionDef {
  key: string;
  poly?: Array<[number, number]>; // [lat, lon]
  circle?: { lat: number; lon: number; km: number };
  bbox: [number, number, number, number]; // latMin, latMax, lonMin, lonMax
}
const polyBox = (p: Array<[number, number]>): RegionDef['bbox'] => [
  Math.min(...p.map((q) => q[0])), Math.max(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[1])),
];
const poly = (key: string, p: Array<[number, number]>): RegionDef => ({ key, poly: p, bbox: polyBox(p) });
const BLR = { lat: 12.9716, lon: 77.5946, km: 500 };

/** Rough polygons (lat, lon). Good enough to be a fixed test of the event machinery, not a border survey. */
export const REGIONS: RegionDef[] = [
  poly('india', INDIA_POLY), // identical to the Layer 2 (T1) polygon so results can be cross-checked
  poly('usa_conus', [[49, -125], [49, -95], [49, -89], [46.5, -84.5], [47.5, -69], [45, -67], [41.5, -70], [35, -75.5], [30.5, -81], [25, -80], [25.5, -97.4], [29, -103], [31.3, -106.5], [32.5, -117], [34.5, -120.6], [40.3, -124.4]]),
  poly('europe', [[36, -10], [36, 26], [41, 45], [70, 45], [70, -10]]),
  poly('china', [[18, 108], [21.5, 101], [22, 98], [28, 97.5], [28.5, 88], [31, 79], [36, 74], [40, 74.5], [45, 80], [49, 87.5], [47.5, 90], [49, 116], [53.5, 123], [48, 135], [43, 131], [42, 128], [39.5, 124], [34, 121], [30, 122], [25, 119.5], [21.5, 111]]),
  poly('brazil', [[5, -60], [2, -50], [-5, -35], [-8, -34.8], [-23, -41], [-26, -48.5], [-33.7, -53.4], [-30, -57.6], [-22, -57.9], [-17, -58], [-10, -65], [-10, -73], [-4, -70], [2, -69.5]]),
  poly('australia', [[-10.7, 142], [-12, 136.5], [-11.5, 131], [-14.5, 125], [-22, 113.5], [-34.5, 115], [-35, 118], [-32, 128], [-33.8, 134], [-38, 140], [-38.5, 146], [-37.5, 150], [-28, 153.6], [-24, 151.5], [-16, 145.5]]),
  poly('japan', [[31, 129.5], [33.5, 129], [35.5, 133], [37.5, 136.5], [41, 139.5], [45.5, 141.5], [43, 145.8], [41.5, 142], [35.5, 141], [34.5, 138.5], [33.5, 135.5], [31, 131]]),
  { key: 'bangalore_500km', circle: BLR, bbox: [BLR.lat - BLR.km / 111.2, BLR.lat + BLR.km / 111.2, BLR.lon - BLR.km / (111.2 * Math.cos(BLR.lat / DEG)) - 0.1, BLR.lon + BLR.km / (111.2 * Math.cos(BLR.lat / DEG)) + 0.1] },
];
export const N_REGIONS = REGIONS.length;
/** Short codes used as payload keys in the packed (one row per object per day) region.pass form. */
export const REGION_CODES = ['IN', 'US', 'EU', 'CN', 'BR', 'AU', 'JP', 'BLR'];
const LAT_MARGIN = 0.4; // geocentric vs geodetic latitude differ by <= 0.192 deg

function pip(p: Array<[number, number]>, lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [yi, xi] = p[i]!, [yj, xj] = p[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function hav(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}
export function regionContains(r: RegionDef, latDeg: number, lonDeg: number): boolean {
  return r.poly ? pip(r.poly, latDeg, lonDeg) : hav(latDeg, lonDeg, r.circle!.lat, r.circle!.lon) <= r.circle!.km;
}

/** Margin (degrees of arc, ~278 km) inside which a sample counts as "near" a region edge: a coarse 20 s step moves the
 *  sub-satellite point at most ~200 km, so any pass that starts and ends between two samples has a sample this close. */
export const NEAR_DEG = 2.5;
function distToRegionDeg(r: RegionDef, lat: number, lon: number): number {
  if (!r.poly) return Math.abs(hav(lat, lon, r.circle!.lat, r.circle!.lon) - r.circle!.km) / 111.2;
  const p = r.poly, c = Math.max(0.2, Math.cos(lat / DEG));
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const [y0, x0] = p[i]!, [y1, x1] = p[(i + 1) % p.length]!;
    const dx = (x1 - x0) * c, dy = y1 - y0, px = (lon - x0) * c, py = lat - y0;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - t * dx, py - t * dy));
  }
  return best;
}

/** Low 8 bits: regions containing the sub-satellite point of a TEME position (km) at sidereal angle theta.
 *  Bits 8..15: regions whose edge is within NEAR_DEG (see events-region.ts). */
/** Geodetic lat/lon (deg) of the sub-satellite point of the latest regionMask() call that got far enough to compute it. */
export const lastLL = new Float64Array(2);
export function regionMask(theta: number, x: number, y: number, z: number, wantNear = true): number {
  const e = temeToEcef({ x, y, z }, theta);
  const lon = Math.atan2(e.y, e.x) * DEG;
  const r = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z);
  const gc = Math.asin(e.z / r) * DEG;
  let mask = 0, near = 0, lat = NaN;
  const gcR = Math.asin(e.z / r);
  for (let k = 0; k < N_REGIONS; k++) {
    const b = REGIONS[k]!.bbox;
    const lonM = NEAR_DEG / Math.max(0.2, Math.cos(Math.min(85, Math.max(Math.abs(b[0]), Math.abs(b[1]))) / DEG));
    if (gc < b[0] - NEAR_DEG - LAT_MARGIN || gc > b[1] + NEAR_DEG + LAT_MARGIN || lon < b[2] - lonM || lon > b[3] + lonM) continue;
    if (lat !== lat) { lat = geodeticLatAltFromEr({ x: e.x / ER_KM, y: e.y / ER_KM, z: e.z / ER_KM }).latDeg ?? gc; }
    if (regionContains(REGIONS[k]!, lat, lon)) mask |= 1 << k;
    if (wantNear && distToRegionDeg(REGIONS[k]!, lat, lon) < NEAR_DEG) near |= 1 << k;
  }
  // latitude for the chord test: exact when computed above; otherwise the cheap surface formula, which is within ~4 km for LEO
  // (< 1,200 km) but off by up to 0.6 deg at MEO/GEO height, so higher objects take the exact function.
  if (lat !== lat) lat = r < 7600 ? Math.atan2(Math.sin(gcR), Math.cos(gcR) * (1 - 0.00669437999)) * DEG : (geodeticLatAltFromEr({ x: e.x / ER_KM, y: e.y / ER_KM, z: e.z / ER_KM }).latDeg ?? gc);
  lastLL[0] = lat; lastLL[1] = lon;
  return mask | (near << NEAR_SHIFT);
}
export { gmst };

// ---------------- propagation helpers ----------------
export function posAt(p: Prop, tMs: number): [number, number, number] | null {
  const pv = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = pv ? pv.position : null;
  if (!r || typeof r === 'boolean' || !Number.isFinite(r.x)) return null;
  return [r.x, r.y, r.z];
}
export function posVelAt(p: Prop, tMs: number): { r: [number, number, number]; v: [number, number, number] } | null {
  const pv = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  if (!pv || typeof pv.position === 'boolean' || typeof pv.velocity === 'boolean' || !Number.isFinite(pv.position.x)) return null;
  return { r: [pv.position.x, pv.position.y, pv.position.z], v: [pv.velocity.x, pv.velocity.y, pv.velocity.z] };
}
export const semiMajorKm = (omm: Record<string, unknown>): number => Math.cbrt(MU / ((Number(omm.MEAN_MOTION) * 2 * Math.PI / 86400) ** 2));

// ---------------- elements.jump metrics ----------------
export interface JumpMetric {
  norad: number;
  regime: string;
  name: string;
  prevEpochMs: number;
  newEpochMs: number;
  gapDays: number;
  /** |prev elset propagated to the new epoch  -  new elset at its epoch|, km. */
  dposKm: number;
  /** Components along the new orbit: radial, along-track, cross-track (km). */
  dRad: number;
  dAlong: number;
  dCross: number;
  /** semi-major axis change from mean motion (km), new minus old. */
  daKm: number;
  /** daKm minus the change drag alone would cause over the gap (old set's own MEAN_MOTION_DOT; OMM stores ndot/2). */
  residKm: number;
  dIncDeg: number;
  dEcc: number;
}
export function jumpMetric(o0: CatFull, o1: CatFull): JumpMetric | null {
  const p0 = makeProp(o0.omm), p1 = makeProp(o1.omm);
  if (!p0 || !p1) return null;
  const a = posAt(p0, p1.epochMs), b = posVelAt(p1, p1.epochMs);
  if (!a || !b) return null;
  const d = [b.r[0] - a[0], b.r[1] - a[1], b.r[2] - a[2]];
  const rn = Math.hypot(...b.r), vn = Math.hypot(...b.v);
  const ur = b.r.map((q) => q / rn), uv = b.v.map((q) => q / vn);
  const cr = [ur[1]! * uv[2]! - ur[2]! * uv[1]!, ur[2]! * uv[0]! - ur[0]! * uv[2]!, ur[0]! * uv[1]! - ur[1]! * uv[0]!];
  const dot = (u: number[]) => d[0]! * u[0]! + d[1]! * u[1]! + d[2]! * u[2]!;
  return {
    norad: o1.noradId, regime: o1.regime, name: o1.name,
    prevEpochMs: p0.epochMs, newEpochMs: p1.epochMs, gapDays: (p1.epochMs - p0.epochMs) / DAY_MS,
    dposKm: Math.hypot(d[0]!, d[1]!, d[2]!), dRad: dot(ur), dAlong: dot(uv), dCross: dot(cr),
    daKm: semiMajorKm(o1.omm) - semiMajorKm(o0.omm),
    residKm: semiMajorKm(o1.omm) - semiMajorKm(o0.omm) + (2 / 3) * (semiMajorKm(o0.omm) / Number(o0.omm.MEAN_MOTION)) * (2 * Number(o0.omm.MEAN_MOTION_DOT) * ((p1.epochMs - p0.epochMs) / DAY_MS)),
    dIncDeg: Number(o1.omm.INCLINATION) - Number(o0.omm.INCLINATION),
    dEcc: Number(o1.omm.ECCENTRICITY) - Number(o0.omm.ECCENTRICITY),
  };
}

export function jumpMetrics(prev: CatFull[], cur: CatFull[]): { metrics: JumpMetric[]; failed: number; unchanged: number; both: number } {
  const pm = new Map(prev.map((o) => [o.noradId, o]));
  const metrics: JumpMetric[] = [];
  let failed = 0, unchanged = 0, both = 0;
  for (const o of cur) {
    const q = pm.get(o.noradId);
    if (!q) continue;
    both++;
    if (String(q.omm.EPOCH) === String(o.omm.EPOCH)) { unchanged++; continue; }
    const m = jumpMetric(q, o);
    if (m) metrics.push(m); else failed++;
  }
  return { metrics, failed, unchanged, both };
}

// ---------------- DB ----------------
export const DDL = `
CREATE SCHEMA IF NOT EXISTS starmap;
CREATE TABLE IF NOT EXISTS starmap.event (
  id bigserial PRIMARY KEY,
  day date NOT NULL,
  kind text NOT NULL,
  subjects int[] NOT NULL,
  t_start timestamptz NOT NULL,
  t_end timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS event_kind_day_idx ON starmap.event (kind, day);
CREATE INDEX IF NOT EXISTS event_subjects_gin ON starmap.event USING gin (subjects);
CREATE INDEX IF NOT EXISTS event_t_start_idx ON starmap.event (t_start);
CREATE TABLE IF NOT EXISTS starmap.event_stats (
  day date PRIMARY KEY,
  stats jsonb NOT NULL
);`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function insertEvents(client: { query: (q: string, v?: unknown[]) => Promise<any> }, day: string, rows: EventRow[]): Promise<void> {
  const B = 20_000;
  for (let o = 0; o < rows.length; o += B) {
    const part = rows.slice(o, o + B);
    await client.query(
      `INSERT INTO starmap.event (day, kind, subjects, t_start, t_end, payload)
       SELECT $1::date, k, ARRAY[a] || CASE WHEN b IS NULL THEN '{}'::int[] ELSE ARRAY[b] END, to_timestamp(ts / 1000.0), to_timestamp(te / 1000.0), p::jsonb
       FROM unnest($2::text[], $3::int[], $4::int[], $5::float8[], $6::float8[], $7::text[]) AS u(k, a, b, ts, te, p)`,
      [day, part.map((r) => r.kind), part.map((r) => r.subjects[0]), part.map((r) => r.subjects[1] ?? null), part.map((r) => r.tStart), part.map((r) => r.tEnd), part.map((r) => JSON.stringify(r.payload))],
    );
  }
}

// ---------------- straight-chord test (lets the region scan skip the 1 s walk when no graze is possible) ----------------
const KM_DEG = 111.2;
/** Slack (km) added to the chord test: the true track bows away from the straight lat/lon chord by < 2 km over a 20 s step (checked
 *  for LEO and HEO at lat <= 70); the margin is 4x that, plus 1% of the chord length. */
export const CHORD_SLACK_KM = 8;
function segPointKm(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function segSegKm(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
  const den = d1x * d2y - d1y * d2x;
  if (den !== 0) {
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den, u = ((cx - ax) * d1y - (cy - ay) * d1x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0; // they cross
  }
  return Math.min(segPointKm(ax, ay, bx, by, cx, cy), segPointKm(ax, ay, bx, by, dx, dy), segPointKm(cx, cy, dx, dy, ax, ay), segPointKm(cx, cy, dx, dy, bx, by));
}
/** True if the straight lat/lon chord A->B (degrees) comes within slack of the boundary of region r (so the track may cut a corner). */
export function chordTouchesRegion(r: RegionDef, latA: number, lonA: number, latB: number, lonB: number, slackKm = CHORD_SLACK_KM): boolean {
  let lb = lonB;
  while (lb - lonA > 180) lb -= 360;
  while (lb - lonA < -180) lb += 360;
  const cosL = Math.max(0.2, Math.cos(((latA + latB) / 2) / DEG));
  const len = Math.hypot((lb - lonA) * cosL, latB - latA) * KM_DEG;
  const eps = slackKm + 0.01 * len;
  const ax = 0, ay = latA * KM_DEG, bx = (lb - lonA) * cosL * KM_DEG, by = latB * KM_DEG;
  if (!r.poly) {
    const cx = (r.circle!.lon - lonA) * cosL * KM_DEG, cy = r.circle!.lat * KM_DEG;
    return segPointKm(ax, ay, bx, by, cx, cy) < r.circle!.km + eps && Math.max(Math.hypot(ax - cx, ay - cy), Math.hypot(bx - cx, by - cy)) > r.circle!.km - eps;
  }
  const p = r.poly;
  for (let i = 0; i < p.length; i++) {
    const [y0, x0] = p[i]!, [y1, x1] = p[(i + 1) % p.length]!;
    let xa = x0 - lonA, xb = x1 - lonA;
    while (xa > 180) xa -= 360; while (xa < -180) xa += 360;
    while (xb > 180) xb -= 360; while (xb < -180) xb += 360;
    if (segSegKm(ax, ay, bx, by, xa * cosL * KM_DEG, y0 * KM_DEG, xb * cosL * KM_DEG, y1 * KM_DEG) < eps) return true;
  }
  return false;
}
/** Longest chord (km) trusted to be straight in lat/lon; longer steps (SGP4 garbage from decaying objects moves 100+ km/s) are always walked. */
export const CHORD_MAX_KM = 400;
/**
 * Must the region scan walk this 20 s bracket at 1 s? True if the straight chord between the two samples (lat/lon, degrees) can
 * touch the boundary of any region (bounding boxes first, then the edge test), or if the chord is too long to trust.
 */
export function chordNeedsWalk(a: Float64Array, b: Float64Array): boolean {
  let lb = b[1]!;
  while (lb - a[1]! > 180) lb -= 360;
  while (lb - a[1]! < -180) lb += 360;
  const cosL = Math.max(0.2, Math.cos(((a[0]! + b[0]!) / 2) / DEG));
  const lenKm = Math.hypot((lb - a[1]!) * cosL, b[0]! - a[0]!) * KM_DEG;
  if (lenKm > CHORD_MAX_KM) return true;
  const pad = (CHORD_SLACK_KM + 0.01 * lenKm) / KM_DEG;
  const latLo = Math.min(a[0]!, b[0]!) - pad, latHi = Math.max(a[0]!, b[0]!) + pad;
  const lonLo = Math.min(a[1]!, lb) - pad / cosL, lonHi = Math.max(a[1]!, lb) + pad / cosL;
  for (let k = 0; k < N_REGIONS; k++) {
    const bb = REGIONS[k]!.bbox;
    if (latHi < bb[0] || latLo > bb[1]) continue;
    let overlap = false;
    for (const sh of [-360, 0, 360]) if (lonHi + sh >= bb[2] && lonLo + sh <= bb[3]) { overlap = true; break; }
    if (overlap && chordTouchesRegion(REGIONS[k]!, a[0]!, a[1]!, b[0]!, b[1]!)) return true;
  }
  return false;
}
