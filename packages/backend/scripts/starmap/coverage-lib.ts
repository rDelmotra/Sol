// ============================================================
// SPIKE — not production. Shared pieces of the Layer 2 daily-coverage experiment:
// the two cell frames (star = SpaceCell box in TEME, Earth = HEALPix ground cell of the
// geodetic sub-satellite point), the India polygon, day catalogs, a small worker pool.
// ============================================================
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import {
  cellKey, ang2pixNest, pix2angNest, gmst, temeToEcef, geodeticLatAltFromEr, ER_KM, RAD, DEG,
} from '@orbitwatch/orbital-core';
import { posAt, NO_CELL, type KeyFn } from './runs.js';

export const HISTORY_DIR = fileURLToPath(new URL('../../data/history/', import.meta.url));
export const COVERAGE_DIR = fileURLToPath(new URL('../../data/coverage/', import.meta.url));
export const DAY_MS = 86_400_000;
export const FENCED = new Set([54922]);
/** Per-day cap on star-frame (order 4) box changes, same spirit as build-index's 5000 rows/day. */
export const STAR_RUN_CAP = 5000;

export const STAR_ORDERS = [2, 3, 4] as const;
export const EARTH_ORDERS = [4, 5, 6] as const;
export const STAR_FINE = 4;
export const EARTH_FINE = 6;
const EARTH_SPAN = 4 ** EARTH_FINE; // 4096 < 12*4^6 = 196608 -> use 2^18 below
const J = 262144; // 2^18 > 12*4^6

/** Sub-satellite point (geodetic) of a TEME position (km) at time tMs. */
export function subPoint(x: number, y: number, z: number, tMs: number): { latDeg: number; lonDeg: number } {
  const e = temeToEcef({ x: x / ER_KM, y: y / ER_KM, z: z / ER_KM }, gmst(tMs));
  const g = geodeticLatAltFromEr(e);
  return { latDeg: g.latDeg ?? 0, lonDeg: Math.atan2(e.y, e.x) * DEG };
}

/** HEALPix NESTED ground cell of a geodetic lat/lon (deg). */
export const groundCell = (order: number, latDeg: number, lonDeg: number): number =>
  ang2pixNest(order, Math.sin(latDeg * RAD), lonDeg * RAD);
void EARTH_SPAN;

/** Joint key: (starKey@4 + 1) * 2^18 + groundCell@6 ; star part 0 = outside the radial range. */
export const jointKey: KeyFn = (p, t, st) => {
  const pos = posAt(p, t, st);
  if (!pos) return NO_CELL;
  const sk = cellKey(STAR_FINE, pos.x, pos.y, pos.z);
  const sp = subPoint(pos.x, pos.y, pos.z, t);
  return (sk === null ? 0 : sk + 1) * J + groundCell(EARTH_FINE, sp.latDeg, sp.lonDeg);
};
export const jointStar = (j: number): number => Math.floor(j / J) - 1; // -1 = none
export const jointEarth = (j: number): number => j % J;

// ---------------- India polygon (rough outline, plain lat/lon) ----------------
export const INDIA_POLY: Array<[lat: number, lon: number]> = [
  [8.0, 77.5], [12.0, 75.0], [20.0, 72.8], [22.5, 68.5], [24.5, 71.0], [28.0, 70.0], [32.5, 74.5],
  [35.5, 77.5], [34.5, 79.5], [30.5, 81.0], [28.5, 88.0], [27.0, 92.0], [28.5, 97.0], [23.5, 93.0],
  [21.5, 89.0], [19.5, 85.0], [13.0, 80.3], [10.0, 79.8],
];
export const POLY_LAT_MIN = Math.min(...INDIA_POLY.map((v) => v[0]));
export const POLY_LAT_MAX = Math.max(...INDIA_POLY.map((v) => v[0]));
export const POLY_LON_MIN = Math.min(...INDIA_POLY.map((v) => v[1]));
export const POLY_LON_MAX = Math.max(...INDIA_POLY.map((v) => v[1]));

/** Even-odd point-in-polygon on plain lat/lon (the polygon does not cross the antimeridian). */
export function inPoly(lat: number, lon: number, poly: Array<[number, number]> = INDIA_POLY): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]!, [yj, xj] = poly[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Conservative ground-cell cover of the polygon at `order`: every cell that contains a point of the
 * polygon. SAMPLING cover: (a) every order+3 cell whose centre is inside the polygon (→ its parent),
 * plus (b) a dense walk along the polygon boundary (step = 1/8 of the cell width) so cells that only a
 * sliver of the polygon touches are kept. Over-inclusion is fine; a miss would show up as recall < 100%.
 */
export function coverPolygon(order: number, poly: Array<[number, number]> = INDIA_POLY): number[] {
  const out = new Set<number>();
  const f = order + 3, shift = 4 ** 3;
  const nPix = 12 * 4 ** f;
  const lo = Math.sin((POLY_LAT_MIN - 1) * RAD), hi = Math.sin((POLY_LAT_MAX + 1) * RAD);
  for (let pix = 0; pix < nPix; pix++) {
    const { z, phi } = pix2angNest(f, pix);
    if (z < lo || z > hi) continue;
    let lon = phi * DEG; if (lon > 180) lon -= 360;
    if (lon < POLY_LON_MIN - 1 || lon > POLY_LON_MAX + 1) continue;
    if (inPoly(Math.asin(z) * DEG, lon, poly)) out.add(Math.floor(pix / shift));
  }
  const widthDeg = Math.sqrt((4 * Math.PI) / (12 * 4 ** order)) * DEG;
  for (let i = 0; i < poly.length; i++) {
    const [la0, lo0] = poly[i]!, [la1, lo1] = poly[(i + 1) % poly.length]!;
    const steps = Math.ceil(Math.hypot(la1 - la0, lo1 - lo0) / (widthDeg / 8)) + 1;
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      out.add(groundCell(order, la0 + (la1 - la0) * u, lo0 + (lo1 - lo0) * u));
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------- days ----------------
export interface DayInfo { day: string; startMs: number; path: string }
/** All history catalogs with >= 30k objects (judged by file size; the sparse early files are < 10 MB). */
export function listDays(): DayInfo[] {
  return readdirSync(HISTORY_DIR)
    .filter((f) => /^catalog-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter((f) => statSync(HISTORY_DIR + f).size > 20_000_000)
    .sort()
    .map((f) => { const day = f.slice(8, 18); return { day, startMs: Date.parse(day + 'T00:00:00Z'), path: HISTORY_DIR + f }; });
}
/** The 29 contiguous daily files 2026-09-20 .. 2026-10-18. */
export const dailyDays = (): DayInfo[] => listDays().filter((d) => d.day >= '2026-09-20');

// ---------------- worker pool ----------------
export class Pool {
  private workers: Worker[] = [];
  private waiting = new Map<number, (v: unknown) => void>();
  private seq = 0;
  constructor(readonly size = 5) {}
  start(): void {
    const boot = fileURLToPath(new URL('./coverage-worker-boot.mjs', import.meta.url));
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(boot);
      w.on('message', (m: { id: number; out: unknown }) => { const r = this.waiting.get(m.id); this.waiting.delete(m.id); r?.(m.out); });
      w.on('error', (e) => { console.error('worker error', e); process.exit(1); });
      this.workers.push(w);
    }
  }
  private send(w: Worker, task: unknown): Promise<unknown> {
    const id = this.seq++;
    return new Promise((res) => { this.waiting.set(id, res); w.postMessage({ id, task }); });
  }
  /** Dynamic scheduling; results in task order. onResult fires as each finishes. */
  async map<T>(tasks: unknown[], onResult?: (r: T, i: number) => void): Promise<T[]> {
    const out = new Array<T>(tasks.length);
    let next = 0;
    await Promise.all(this.workers.map(async (w) => {
      for (;;) {
        const k = next++;
        if (k >= tasks.length) return;
        const r = (await this.send(w, tasks[k])) as T;
        out[k] = r; onResult?.(r, k);
      }
    }));
    return out;
  }
  async close(): Promise<void> { await Promise.all(this.workers.map((w) => w.terminate())); }
}
