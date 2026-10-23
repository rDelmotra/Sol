// ============================================================
// SPIKE — not production. Shared pieces of the Layer 2 star-map coverage experiment.
//
// OWNER RULE: satellites are indexed ONLY in the star map (TEME, which does not rotate with the Earth).
// There is deliberately no Earth-fixed cell code for satellites here. Ground places (India) are rotated
// INTO the star map per time slice (see coverage-cover.ts). The sub-satellite point helper below is only
// used to ANSWER a ground question exactly (refine / brute force), never to index.
// ============================================================
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import { gmst, temeToEcef, geodeticLatAltFromEr, ER_KM, DEG, WGS84_A_KM, SHELL_DELTA0 } from '@orbitwatch/orbital-core';

export const HISTORY_DIR = fileURLToPath(new URL('../../data/history/', import.meta.url));
export const COVERAGE_DIR = fileURLToPath(new URL('../../data/coverage/', import.meta.url));
export const DAY_MS = 86_400_000;
export const FENCED = new Set([54922]);
/** Per-day cap on order-4 star box changes, same spirit as build-index's 5000 rows/day. */
export const STAR_RUN_CAP = 5000;

/** Star-map orders stored. Order 4 is the only one swept by SGP4; 3 and 2 are exact parents. */
export const STAR_ORDERS = [2, 3, 4] as const;
export const STAR_FINE = 4;
/** Object index is packed under the key as key * ID_SHIFT + index (index < 65536). */
export const ID_SHIFT = 65536;

/** Radial range the star map can encode (cellKey returns null outside it). */
export const R_MIN_KM = WGS84_A_KM * Math.exp(-SHELL_DELTA0) * 1.0000001;
export const R_MAX_KM = WGS84_A_KM * Math.exp(7 * SHELL_DELTA0) * 0.9999999;

// ---------------- granularities (periods inside a UTC day) ----------------
export interface Gran { id: number; name: string; periodMs: number; perDay: number }
export const GRANS: Gran[] = [
  { id: 0, name: 'day', periodMs: DAY_MS, perDay: 1 },
  { id: 1, name: 'hour', periodMs: 3_600_000, perDay: 24 },
  { id: 2, name: 'm10', periodMs: 600_000, perDay: 144 },
];
export const granByName = (n: string): Gran => GRANS.find((g) => g.name === n)!;

/** Sub-satellite point (geodetic latitude, longitude) of a TEME position (km) at time tMs. Exact answering only. */
export function subPoint(x: number, y: number, z: number, tMs: number): { latDeg: number; lonDeg: number } {
  const e = temeToEcef({ x: x / ER_KM, y: y / ER_KM, z: z / ER_KM }, gmst(tMs));
  const g = geodeticLatAltFromEr(e);
  return { latDeg: g.latDeg ?? 0, lonDeg: Math.atan2(e.y, e.x) * DEG };
}

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

/** Distance (degrees, plain lat/lon plane) from a point to the nearest polygon edge. */
export function distToPolyEdges(lat: number, lon: number, poly: Array<[number, number]> = INDIA_POLY): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [y0, x0] = poly[i]!, [y1, x1] = poly[(i + 1) % poly.length]!;
    const dx = x1 - x0, dy = y1 - y0;
    const t = Math.max(0, Math.min(1, ((lon - x0) * dx + (lat - y0) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(lon - (x0 + t * dx), lat - (y0 + t * dy)));
  }
  return best;
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
/** The weekly files from 2026-06-30 up to (not including) the daily range. */
export const weeklyDays = (): DayInfo[] => listDays().filter((d) => d.day >= '2026-06-30' && d.day < '2026-09-20');

// ---------------- worker pool ----------------
export class Pool {
  private workers: Worker[] = [];
  private waiting = new Map<number, (v: unknown) => void>();
  private seq = 0;
  constructor(readonly size = 4) {}
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
