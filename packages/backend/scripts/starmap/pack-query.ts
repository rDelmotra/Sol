// ============================================================
// SPIKE — not production. Browser pack (P5): the three questions, as pure functions the browser worker runs on pack
// data. No Node imports (bundled by esbuild for the page). pack-verify.ts answers the same questions in Node with
// the older spike code (runs.ts / coverage-lib.ts / coverage-codec.ts on the ORIGINAL files) and compares.
// ============================================================
import * as satellite from 'satellite.js';
import { gmst, temeToEcef, geodeticLatAltFromEr, ER_KM, DEG } from '@orbitwatch/orbital-core';
import { readCoverage, findCell, forEachId, GRAN_DAY } from './coverage-codec.js';
import { rowToOmm, type ElsetRow } from './pack-format.js';

const MS_PER_DAY = 86_400_000;
const JD_UNIX_EPOCH = 2440587.5;
/** Same hard cap the live app uses: |t - epoch| <= 60 d. */
export const MAX_TSINCE_MIN = 60 * 1440;

export interface Sat { norad: number; satrec: ReturnType<typeof satellite.json2satrec>; epochMs: number }

export function makeSat(r: ElsetRow): Sat | null {
  try {
    const satrec = satellite.json2satrec(rowToOmm(r) as Parameters<typeof satellite.json2satrec>[0]);
    if (satrec.error) return null;
    const epochMs = (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY;
    if (!Number.isFinite(epochMs)) return null;
    return { norad: r.norad, satrec, epochMs };
  } catch { return null; }
}

/** TEME position (km) at tMs, or null (SGP4 failure, non-finite, or outside the 60 d cap). */
export function teme(s: Sat, tMs: number): { x: number; y: number; z: number } | null {
  if (Math.abs(tMs - s.epochMs) > MAX_TSINCE_MIN * 60_000) return null;
  const pv = satellite.sgp4(s.satrec, (tMs - s.epochMs) / 60_000);
  const p = pv ? pv.position : null;
  if (!p || typeof p === 'boolean' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  return p;
}

/** Even-odd point-in-polygon on plain lat/lon (same rule as coverage-lib.inPoly). */
export function inPoly(lat: number, lon: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]!, [yj, xj] = poly[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Hit { norad: number; latDeg: number; lonDeg: number; altKm: number; x: number; y: number; z: number }

/**
 * Q1: every object whose sub-satellite point (geodetic) is inside `poly` at tMs. SGP4 for ALL objects, then a cheap
 * latitude-band prune (geocentric latitude within the polygon's band +-1 deg; geodetic and geocentric differ by <= 0.2 deg),
 * then the exact geodetic + polygon test.
 */
export function overPolygon(sats: Sat[], tMs: number, poly: ReadonlyArray<readonly [number, number]>): { hits: Hit[]; failed: number; propagated: number } {
  let latMin = 90, latMax = -90;
  for (const v of poly) { if (v[0] < latMin) latMin = v[0]; if (v[0] > latMax) latMax = v[0]; }
  const sLo = Math.sin((latMin - 1) / DEG), sHi = Math.sin((latMax + 1) / DEG);
  const theta = gmst(tMs);
  const hits: Hit[] = [];
  let failed = 0;
  for (const s of sats) {
    const p = teme(s, tMs);
    if (!p) { failed++; continue; }
    const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    const sz = p.z / r;
    if (sz < sLo || sz > sHi) continue;
    const e = temeToEcef({ x: p.x / ER_KM, y: p.y / ER_KM, z: p.z / ER_KM }, theta);
    const g = geodeticLatAltFromEr(e);
    const lat = g.latDeg ?? 0, lon = Math.atan2(e.y, e.x) * DEG;
    if (inPoly(lat, lon, poly)) hits.push({ norad: s.norad, latDeg: lat, lonDeg: lon, altKm: g.altKm, x: p.x, y: p.y, z: p.z });
  }
  hits.sort((a, b) => a.norad - b.norad);
  return { hits, failed, propagated: sats.length };
}

/** Q2: one object's TEME positions (km, xyz interleaved) from t0Ms for `hours` every stepS seconds, plus geodetic lat/lon/alt. */
export function pathOf(s: Sat, t0Ms: number, hours: number, stepS: number): { n: number; teme: Float64Array; lat: Float64Array; lon: Float64Array; alt: Float64Array; failed: number } {
  const n = Math.floor((hours * 3600) / stepS) + 1;
  const T = new Float64Array(n * 3), lat = new Float64Array(n), lon = new Float64Array(n), alt = new Float64Array(n);
  let failed = 0;
  for (let i = 0; i < n; i++) {
    const t = t0Ms + i * stepS * 1000;
    const p = teme(s, t);
    if (!p) { failed++; T[i * 3] = T[i * 3 + 1] = T[i * 3 + 2] = NaN; lat[i] = lon[i] = alt[i] = NaN; continue; }
    T[i * 3] = p.x; T[i * 3 + 1] = p.y; T[i * 3 + 2] = p.z;
    const e = temeToEcef({ x: p.x / ER_KM, y: p.y / ER_KM, z: p.z / ER_KM }, gmst(t));
    const g = geodeticLatAltFromEr(e);
    lat[i] = g.latDeg ?? 0; lon[i] = Math.atan2(e.y, e.x) * DEG; alt[i] = g.altKm;
  }
  return { n, teme: T, lat, lon, alt, failed };
}

/** Q3: NORAD ids listed in star-map box `cell` of `order` for one pack day (whole-day granularity), ascending. */
export function boxMembers(dayFile: Uint8Array, order: number, cell: number): number[] {
  const cov = readCoverage(dayFile);
  const cfg = cov.configs.find((c) => c.gran === GRAN_DAY && c.order === order);
  if (!cfg) throw new Error(`day file has no day/order-${order} list`);
  const i = findCell(cfg, cell);
  if (i < 0) return [];
  const out: number[] = [];
  forEachId(cov.buf, cfg.offs[i]!, cfg.lens[i]!, cfg.tags[i]!, (id) => out.push(cov.norad[id]!));
  return out.sort((a, b) => a - b);
}

/** Raw SGP4 throughput: propagate every sat at `passes` different times; returns calls and elapsed ms (caller times). */
export function sgp4Burst(sats: Sat[], t0Ms: number, passes: number, nowMs: () => number): { calls: number; ms: number; ok: number } {
  const a = nowMs();
  let calls = 0, ok = 0;
  for (let k = 0; k < passes; k++) {
    const t = t0Ms + k * 61_000;
    for (const s of sats) {
      const pv = satellite.sgp4(s.satrec, (t - s.epochMs) / 60_000);
      calls++;
      if (pv && typeof pv.position !== 'boolean') ok++;
    }
  }
  return { calls, ms: nowMs() - a, ok };
}
