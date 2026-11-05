// ============================================================
// The daily coverage build. Ported from scripts/starmap/coverage.ts (frozen spike): for one UTC day and the day's own element sets,
// ONE SGP4 pass per object (10 s step, box changes bisected to ~1 s) in the star map (TEME) at order 4, then the inverted lists
//   day o3, day o4, hour o4        key (cell * periodsPerDay + period) -> sorted object indices
// Objects the build cannot index are recorded and handled so queries stay exact:
//   over-row-cap   (flips boxes constantly: a decaying object) -> manifest.unindexed: ALWAYS a candidate
//   fenced / bad-elements / outside-60d-epoch-cap / no-valid-position -> counted in manifest.skipped, never an answer (they cannot be
//   propagated, so the exact refine cannot confirm them either)
// Runs in its own worker pool (sequential with the screener's pool, released at the end) so the two never hold memory together.
// ============================================================
import { decodeKey } from '@orbitwatch/orbital-core';
import { WorkerPool } from '../pool.js';
import { writeLayer } from './codec.js';
import { LAYERS, layerName, ID_SHIFT, DAY_MS, BUILD_STEP_MS, GRAN_ID } from './consts.js';
import type { OmmObject } from './catalog.js';
import type { LayerInfo, Manifest, PositionAccuracy } from './store.js';
import type { BuildTask, BuildOut } from './worker.js';
import { CODEC_VERSION } from './codec.js';

const CHUNK = 200;

export interface BuildOpts {
  workers?: number;
  stepMs?: number;
  /** cap the catalog (tests, benchmarks) */
  limit?: number;
  /** false: build the daily layers only (no hour.o4). Default true. The history backfill builds no hourly layers. */
  hourly?: boolean;
  /** an already started pool (init sent) to reuse across days; it is NOT closed here. Default: a pool of `workers` for this day. */
  pool?: WorkerPool;
  /** position accuracy of the day's element sets (history backfill, era table); written to the manifest as `accuracy` */
  accuracy?: PositionAccuracy;
}
export interface BuiltDay { manifest: Manifest; files: Map<string, Uint8Array> }

export async function buildDay(day: string, startMs: number, catalog: OmmObject[], opts: BuildOpts = {}): Promise<BuiltDay> {
  const T0 = Date.now();
  const cat = opts.limit ? catalog.slice(0, opts.limit) : catalog;
  if (cat.length >= ID_SHIFT) throw new Error(`coverage build: ${cat.length} objects do not fit the ${ID_SHIFT}-object index`);
  const stepMs = opts.stepMs ?? BUILD_STEP_MS;
  const nWorkers = Math.max(1, opts.pool?.size ?? opts.workers ?? 4);
  const hourly = opts.hourly !== false;
  const tasks: BuildTask[] = [];
  for (let b = 0; b < cat.length; b += CHUNK) {
    const sl = cat.slice(b, b + CHUNK);
    const t: BuildTask = { kind: 'build', omms: sl.map((o) => o.omm), norad: sl.map((o) => o.noradId), base: b, startMs, endMs: startMs + DAY_MS, stepMs, hourly };
    if (sl.some((o) => o.propagator && o.propagator !== 'sgp4')) t.props = sl.map((o) => o.propagator ?? null);
    tasks.push(t);
  }
  const pool = opts.pool ?? new WorkerPool(nWorkers, 'coverage/worker');
  const parts: Float64Array[][] = LAYERS.map(() => []);
  const skipReasons: Record<string, number> = {};
  const unindexed: number[] = [];
  let propCalls = 0;
  try {
    if (!opts.pool) await pool.start({ kind: 'init' });
    await pool.map<BuildOut>(tasks).then((outs) => {
      outs.forEach((r, ti) => {
        propCalls += r.propCalls;
        r.pairs.forEach((arr, c) => parts[c]!.push(arr));
        for (const [i, why] of r.skips) {
          const k = why.startsWith('over-row-cap') ? 'over-row-cap' : why;
          skipReasons[k] = (skipReasons[k] ?? 0) + 1;
          if (k === 'over-row-cap') unindexed.push(cat[ti * CHUNK + i]!.noradId);
        }
      });
    });
  } finally {
    if (!opts.pool) await pool.close();
  }
  const tSgp = Date.now() - T0;

  let tSort = 0, tEnc = 0;
  const files = new Map<string, Uint8Array>();
  const layers: Record<string, LayerInfo> = {};
  const nkRange = new Map<number, [number, number]>(); // order -> [lo, hi], from the daily layer's cells
  for (let c = 0; c < LAYERS.length; c++) {
    const layer = LAYERS[c]!;
    if (!hourly && layer.gran === 'hour') continue;
    const ts = Date.now();
    let n = 0; for (const p of parts[c]!) n += p.length;
    const flat = new Float64Array(n); let off = 0;
    for (const p of parts[c]!) { flat.set(p, off); off += p.length; }
    parts[c] = [];
    flat.sort();
    const ids = new Uint32Array(n);
    const m = new Map<number, Uint32Array>();
    let start = 0, curKey = n ? Math.floor(flat[0]! / ID_SHIFT) : 0;
    for (let i = 0; i < n; i++) {
      const key = Math.floor(flat[i]! / ID_SHIFT);
      ids[i] = flat[i]! - key * ID_SHIFT;
      if (key !== curKey) { m.set(curKey, ids.subarray(start, i)); start = i; curKey = key; }
    }
    if (n) m.set(curKey, ids.subarray(start, n));
    tSort += Date.now() - ts;
    if (layer.gran === 'day') {
      let lo = Infinity, hi = -Infinity;
      for (const key of m.keys()) { const nk = decodeKey(layer.order, key).nk; if (nk < lo) lo = nk; if (nk > hi) hi = nk; }
      nkRange.set(layer.order, [lo, hi]);
    }
    const te = Date.now();
    const { file, stats } = writeLayer(GRAN_ID[layer.gran], layer.order, startMs, cat.length, m);
    tEnc += Date.now() - te;
    const [nkLo, nkHi] = nkRange.get(layer.order) ?? [0, 0];
    const name = `${layerName(layer)}.bin`;
    files.set(name, file);
    layers[layerName(layer)] = { file: name, bytes: file.length, lists: stats.nCells, pairs: stats.nPairs, nkLo, nkHi };
  }
  const wall = (Date.now() - T0) / 1000;
  const sgpIds = cat.filter((o) => o.propagator === 'sgp').map((o) => o.noradId);
  const manifest: Manifest = {
    version: CODEC_VERSION, day, dayStartMs: startMs, builtAt: new Date().toISOString(), objects: cat.length,
    norad: cat.map((o) => o.noradId), unindexed: unindexed.sort((a, b) => a - b), skipped: skipReasons, layers,
    ...(sgpIds.length ? { propagators: { sgp: sgpIds } } : {}),
    ...(opts.accuracy ? { accuracy: opts.accuracy } : {}),
    build: {
      stepS: stepMs / 1000, workers: nWorkers, propCalls, wallS: +wall.toFixed(1), sgp4S: +(tSgp / 1000).toFixed(1), sortS: +(tSort / 1000).toFixed(1),
      encodeS: +(tEnc / 1000).toFixed(1), peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    },
  };
  return { manifest, files };
}
