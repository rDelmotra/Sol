// ============================================================
// SPIKE — not production. Shared main-thread side of the screening experiments:
// catalog context (elements, pads, wires, shared memory), a small worker pool, helpers.
// ============================================================
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import * as satellite from 'satellite.js';
import { loadCatalog, type CatObj } from './catalog.js';
import { makeProp, windowInCap, type Prop } from './runs.js';
import { elementsFromOmm, driftBoundKm, sameElementSet, type Elements } from './invariants.js';
import { wireFromElements, sampleWire, COARSE_N } from './moid.js';
import type { InitMsg, SharedLayout, Task } from './screen-types.js';

export const WIN_START = Date.parse('2026-10-20T01:00:00Z');
export const WIN_END = Date.parse('2026-10-20T02:00:00Z');
export const WIN_MID = (WIN_START + WIN_END) / 2;
export const HALF_WINDOW_S = (WIN_END - WIN_START) / 2000;
/** Row-guard fenced object: a decayed fragment whose SGP4 output is garbage (see STARMAP.md). */
export const FENCED = new Set([54922]);
export const DT_MS = 5000;
export const VMAX_KMS = 20; // bound on relative speed of two bound near-Earth objects (LEO vs HEO perigee ~ 18)
export const candD = (stride: number) => 10 + (VMAX_KMS * stride * DT_MS) / 2000 + 1;

export type PadMode = 'max' | 'p99';
interface PadRow { n: number; below: number; above: number; ell: number; p99: { below: number; above: number; ell: number } }

export interface Ctx {
  n: number;
  objs: CatObj[];
  els: Elements[];
  props: Prop[];
  /** Identical-element-set group id per object (-1 = unique). */
  group: Int32Array;
  groups: number[][];
  wild: number; // objects whose own measured excursion exceeds the regime pad
  padMode: PadMode;
  padRegime: Record<string, { below: number; above: number; ell: number }>;
  lo: Float64Array; hi: Float64Array; pad1: Float64Array;
  wires: Float64Array; samples: Float64Array;
  ord: Int32Array; loS: Float64Array; hiS: Float64Array;
  shared: SharedLayout;
  pos: Float32Array;
  nSteps: number;
}

const sab = (bytes: number) => new SharedArrayBuffer(bytes);
const regKey = (r: string) => (r === 'OTHER' ? 'HEO' : r);

/** Build the context. Pads: max or p99 of the stratified calibration, raised per object to its own measured value. */
export function loadCtx(padMode: PadMode = 'max', opts: { windowOnly?: boolean } = {}): Ctx {
  const t0 = Date.now();
  const objs: CatObj[] = [];
  const els: Elements[] = [];
  const props: Prop[] = [];
  for (const o of loadCatalog()) {
    if (FENCED.has(o.noradId)) continue;
    const p = makeProp(o.omm);
    const el = elementsFromOmm(o.noradId, o.omm);
    if (!p || !el || !windowInCap(p, WIN_START, WIN_END)) continue;
    objs.push(o); els.push(el); props.push(p);
  }
  const n = objs.length;
  const padsFile = JSON.parse(readFileSync('/tmp/starmap/pads.json', 'utf8')) as Record<string, PadRow>;
  const perObj = existsSync('/tmp/starmap/pads-objects.json')
    ? (JSON.parse(readFileSync('/tmp/starmap/pads-objects.json', 'utf8')) as Record<string, number[]>) : {};
  const padRegime: Ctx['padRegime'] = {};
  for (const [k, v] of Object.entries(padsFile)) padRegime[k] = padMode === 'max' ? { below: v.below, above: v.above, ell: v.ell } : { ...v.p99 };

  const nSteps = (WIN_END - WIN_START) / DT_MS + 1;
  const shared: SharedLayout = {
    n, nSteps, t0Ms: WIN_START, dtMs: DT_MS,
    pos: sab(opts.windowOnly ? 4 : n * nSteps * 3 * 4), lo: sab(n * 8), hi: sab(n * 8), ord: sab(n * 4), loS: sab(n * 8), hiS: sab(n * 8),
    wires: sab(n * 9 * 8), samples: sab(n * COARSE_N * 3 * 8), pad1: sab(n * 8),
  };
  const lo = new Float64Array(shared.lo), hi = new Float64Array(shared.hi), pad1 = new Float64Array(shared.pad1);
  const wires = new Float64Array(shared.wires), samples = new Float64Array(shared.samples);
  let wild = 0;
  for (let i = 0; i < n; i++) {
    const el = els[i]!;
    const pr = padRegime[regKey(objs[i]!.regime)] ?? padRegime.HEO!;
    const own = perObj[String(el.norad)];
    let below = pr.below, above = pr.above, ell = pr.ell;
    if (own) {
      if (own[0]! > below || own[1]! > above || own[2]! > ell) wild++;
      below = Math.max(below, own[0]!); above = Math.max(above, own[1]!); ell = Math.max(ell, own[2]!);
    }
    lo[i] = el.rp - below; hi[i] = el.ra + above;
    pad1[i] = ell + driftBoundKm(el, HALF_WINDOW_S);
    const w = wireFromElements(el, WIN_MID, wires.subarray(i * 9, i * 9 + 9));
    sampleWire(w, samples.subarray(i * COARSE_N * 3, (i + 1) * COARSE_N * 3));
  }
  const ord = new Int32Array(shared.ord);
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => lo[a]! - lo[b]!);
  const loS = new Float64Array(shared.loS), hiS = new Float64Array(shared.hiS);
  idx.forEach((v, u) => { ord[u] = v; loS[u] = lo[v]!; hiS[u] = hi[v]!; });

  // identical element sets
  const group = new Int32Array(n).fill(-1);
  const byKey = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const m = objs[i]!.omm;
    const key = [m.EPOCH, m.MEAN_MOTION, m.ECCENTRICITY, m.INCLINATION, m.RA_OF_ASC_NODE, m.ARG_OF_PERICENTER, m.MEAN_ANOMALY, m.BSTAR].join('|');
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(i);
  }
  const groups: number[][] = [];
  for (const g of byKey.values()) if (g.length > 1) { g.forEach((i) => (group[i] = groups.length)); groups.push(g); }
  void sameElementSet;
  console.log(`[ctx] ${n} objects, pads=${padMode}, wild(objects above regime pad)=${wild}, identical-element-set groups=${groups.length} (${groups.reduce((s, g) => s + g.length, 0)} objects), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { n, objs, els, props, group, groups, wild, padMode, padRegime, lo, hi, pad1, wires, samples, ord, loS, hiS, shared, pos: new Float32Array(shared.pos), nSteps };
}

export class Pool {
  private workers: Worker[] = [];
  private waiting = new Map<number, (v: unknown) => void>();
  private seq = 0;
  size: number;
  constructor(size = availableParallelism()) { this.size = size; }
  async start(ctx: Ctx): Promise<void> {
    const boot = fileURLToPath(new URL('./screen-worker-boot.mjs', import.meta.url));
    const init: InitMsg = { type: 'init', omm: ctx.objs.map((o) => o.omm), shared: ctx.shared };
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(boot);
      w.on('message', (m: { id: number; out: unknown }) => { const r = this.waiting.get(m.id); this.waiting.delete(m.id); r?.(m.out); });
      w.on('error', (e) => { console.error('worker error', e); process.exit(1); });
      this.workers.push(w);
    }
    await Promise.all(this.workers.map((w) => this.send(w, init)));
  }
  private send(w: Worker, msg: InitMsg | Task): Promise<unknown> {
    const id = this.seq++;
    return new Promise((res) => { this.waiting.set(id, res); w.postMessage({ id, msg }); });
  }
  /** Run tasks on the pool (dynamic scheduling), results in task order. */
  async map<T>(tasks: Task[]): Promise<T[]> {
    const out = new Array<T>(tasks.length);
    let next = 0;
    await Promise.all(this.workers.map(async (w) => {
      for (;;) {
        const k = next++;
        if (k >= tasks.length) return;
        out[k] = (await this.send(w, tasks[k]!)) as T;
      }
    }));
    return out;
  }
  async close(): Promise<void> { await Promise.all(this.workers.map((w) => w.terminate())); }
}

export function sgp4Pos(p: Prop, tMs: number): [number, number, number] | null {
  const pv = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = pv ? pv.position : null;
  if (!r || typeof r === 'boolean' || !Number.isFinite(r.x)) return null;
  return [r.x, r.y, r.z];
}

export const secs = (t0: number) => (Date.now() - t0) / 1000;
export const f1 = (x: number) => x.toFixed(1);
