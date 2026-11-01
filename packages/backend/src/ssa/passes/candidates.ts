// ============================================================
// Candidate windows of one UTC day: rotate the region into star-map cells per period (hourly lists where present for sharper
// candidate sets, else daily), union the lists, add the unindexed objects, and turn each object's candidate periods into time windows.
// A pass of the exact refine can only happen inside these windows (the lists miss nothing at 10-second resolution; shorter visits are
// found by the refine). Per day the layer is chosen like the spike planner: hourly order 4 if the file is there, else daily order 4.
// ============================================================
import { DAY_MS, PER_DAY, PERIOD_MS, type Gran, type LayerId } from '../coverage/consts.js';
import { coverPixels, cellsOf } from '../coverage/cover.js';
import { findCell, listIds, type Layer } from '../coverage/codec.js';
import type { Region } from '../coverage/region.js';
import { hasLayer, openLayer, type Manifest } from '../coverage/store.js';

export interface DayLayer { layer: LayerId; gran: Gran }

/** The sharpest layer available for the day, or null. */
export function chooseLayer(dir: string, m: Manifest): DayLayer | null {
  for (const l of [{ gran: 'hour', order: 4 }, { gran: 'day', order: 4 }] as LayerId[]) {
    if (m.layers[`${l.gran}.o${l.order}`] && hasLayer(dir, m.day, l)) return { layer: l, gran: l.gran };
  }
  return null;
}

// Cover pixels do not depend on the data, only on (region, order, day, granularity): keep the recent ones.
const pixelCache = new Map<string, Int32Array[]>();
function pixelsFor(order: number, region: Region, dayStartMs: number, gran: Gran): Int32Array[] {
  const k = `${region.id}|${order}|${dayStartMs}|${gran}`;
  let v = pixelCache.get(k);
  if (v) { pixelCache.delete(k); pixelCache.set(k, v); return v; }
  v = coverPixels(order, region, dayStartMs, gran);
  pixelCache.set(k, v);
  while (pixelCache.size > 400) pixelCache.delete(pixelCache.keys().next().value as string);
  return v;
}

export interface DayCandidates {
  day: string;
  gran: Gran;
  order: number;
  /** object index (position in manifest.norad) -> flat [startMs, endMs, ...], clipped to [fromMs, toMs) */
  windows: Map<number, number[]>;
  stats: { coverCells: number; lists: number; listObjects: number };
}

/**
 * @param only  restrict to these object indices (detail queries); undefined = all
 */
export function dayCandidates(dir: string, m: Manifest, region: Region, fromMs: number, toMs: number, dl: DayLayer, only?: ReadonlySet<number>): DayCandidates {
  const layer: Layer = openLayer(dir, m.day, dl.layer);
  const P = PER_DAY[dl.gran], per = PERIOD_MS[dl.gran], n = layer.n;
  const info = m.layers[`${dl.gran}.o${dl.layer.order}`]!;
  const pix = pixelsFor(dl.layer.order, region, m.dayStartMs, dl.gran);
  const cand = new Uint8Array(n * P);
  let coverCells = 0, lists = 0, listObjects = 0;
  for (let p = 0; p < P; p++) {
    // skip periods outside the requested window
    if (m.dayStartMs + (p + 1) * per <= fromMs || m.dayStartMs + p * per >= toMs) continue;
    const cells = cellsOf(dl.layer.order, pix[p]!, info.nkLo, info.nkHi);
    coverCells += cells.length;
    for (const cell of cells) {
      const i = findCell(layer, cell * P + p);
      if (i < 0) continue;
      lists++;
      listIds(layer, i, (id) => { listObjects++; cand[id * P + p] = 1; });
    }
  }
  // objects the build could not index are always candidates
  if (m.unindexed.length) {
    const idx = new Map<number, number>(); m.norad.forEach((nd, i) => idx.set(nd, i));
    for (const nd of m.unindexed) { const i = idx.get(nd); if (i !== undefined) cand.fill(1, i * P, (i + 1) * P); }
  }
  const windows = new Map<number, number[]>();
  const lo = Math.max(0, Math.floor((fromMs - m.dayStartMs) / per)), hi = Math.min(P, Math.ceil((toMs - m.dayStartMs) / per));
  const scan = (i: number): void => {
    let w: number[] | null = null, p = lo;
    while (p < hi) {
      if (!cand[i * P + p]) { p++; continue; }
      let q = p; while (q < hi && cand[i * P + q]) q++;
      (w ??= []).push(Math.max(fromMs, m.dayStartMs + p * per), Math.min(toMs, m.dayStartMs + q * per, m.dayStartMs + DAY_MS));
      p = q;
    }
    if (w) windows.set(i, w);
  };
  if (only) for (const i of only) scan(i); else for (let i = 0; i < n; i++) scan(i);
  return { day: m.day, gran: dl.gran, order: dl.layer.order, windows, stats: { coverCells, lists, listObjects } };
}

/** Windows of a day without coverage, brute force: every object, the whole (clipped) day. */
export function wholeDayWindows(dayStartMs: number, fromMs: number, toMs: number, ids: Iterable<number>): Map<number, number[]> {
  const a = Math.max(fromMs, dayStartMs), b = Math.min(toMs, dayStartMs + DAY_MS);
  const out = new Map<number, number[]>();
  if (b > a) for (const i of ids) out.set(i, [a, b]);
  return out;
}
