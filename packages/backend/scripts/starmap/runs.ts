// ============================================================
// SPIKE — not production.
//
// Core of the star-fixed spatio-temporal index: turn ONE satellite's SGP4
// trajectory into "runs" (an object staying inside one SpaceCell box).
//
// Method: sample the position every `stepMs`; when the box changes between two
// samples, BISECT the interval (propagating at the midpoint) down to <= 1 s.
// If the midpoint lands in a third box, both halves recurse, so the clipped
// corner gets its own run. Failures / out-of-range radii are a "no cell" state
// (-1) that ends the current run and is counted, never emitted.
//
// Used by build-index.ts (stepped) and measure.ts (stepped vs 1 s ground truth).
// Frame is TEME (what SGP4 outputs): star-fixed, so a stationary box needs no
// Earth-rotation correction.
// ============================================================

import * as satellite from 'satellite.js';
import { cellKey } from '@orbitwatch/orbital-core';

export const NO_CELL = -1;
/** Bisection stops when the bracket is this wide (ms). */
export const BISECT_MS = 1000;
const MS_PER_DAY = 86_400_000;
const JD_UNIX_EPOCH = 2440587.5;
/** Same hard cap the live app uses: |t - epoch| <= 60 d (see orbital-core/propagation-window.ts). */
export const MAX_TSINCE_MIN = 60 * 1440;

export type SatRec = ReturnType<typeof satellite.json2satrec>;

export interface RunStats {
  /** SGP4 evaluations. */
  propCalls: number;
  /** Evaluations that failed or fell outside the radial range. */
  noCell: number;
}
export const newStats = (): RunStats => ({ propCalls: 0, noCell: 0 });

/** One run: object in box `cell` from tIn to tOut (UTC ms). */
export interface Run {
  cell: number;
  tIn: number;
  tOut: number;
}

export interface Prop {
  satrec: SatRec;
  epochMs: number;
}

/** Build a satrec; null if elements are unusable. */
export function makeProp(omm: unknown): Prop | null {
  try {
    const satrec = satellite.json2satrec(omm as Parameters<typeof satellite.json2satrec>[0]);
    if (satrec.error) return null;
    const epochMs = (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY;
    if (!Number.isFinite(epochMs)) return null;
    return { satrec, epochMs };
  } catch {
    return null;
  }
}

/** True if the whole [startMs,endMs] window is inside the +-60 d tsince cap. */
export function windowInCap(p: Prop, startMs: number, endMs: number): boolean {
  const lim = MAX_TSINCE_MIN * 60_000;
  return Math.abs(startMs - p.epochMs) <= lim && Math.abs(endMs - p.epochMs) <= lim;
}

/** Cell key at time tMs, or NO_CELL. */
export function cellAt(p: Prop, order: number, tMs: number, st: RunStats): number {
  st.propCalls++;
  const tsince = (tMs - p.epochMs) / 60_000;
  const pv = satellite.sgp4(p.satrec, tsince);
  const pos = pv ? pv.position : null;
  if (!pos || typeof pos === 'boolean' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    st.noCell++;
    return NO_CELL;
  }
  const k = cellKey(order, pos.x, pos.y, pos.z);
  if (k === null) {
    st.noCell++;
    return NO_CELL;
  }
  return k;
}

interface Event {
  t: number;
  cell: number;
}

/** Push, in time order, the transition events inside (tLo,tHi] where cell goes cLo -> cHi. */
function resolve(
  p: Prop, order: number, tLo: number, cLo: number, tHi: number, cHi: number,
  st: RunStats, out: Event[],
): void {
  if (cLo === cHi) return;
  if (tHi - tLo <= BISECT_MS) {
    out.push({ t: Math.round((tLo + tHi) / 2), cell: cHi });
    return;
  }
  const tMid = Math.floor((tLo + tHi) / 2);
  const cMid = cellAt(p, order, tMid, st);
  if (cMid !== cLo) resolve(p, order, tLo, cLo, tMid, cMid, st, out);
  if (cMid !== cHi) resolve(p, order, tMid, cMid, tHi, cHi, st, out);
}

/**
 * Runs of one object over [startMs, endMs], sampled every stepMs and bisected to ~1 s.
 * Runs are clipped to the window and are NOT split at bucket boundaries (see splitAtBuckets).
 */
export function buildRuns(
  p: Prop, order: number, startMs: number, endMs: number, stepMs: number, st: RunStats,
): Run[] {
  const events: Event[] = [];
  let tPrev = startMs;
  let cPrev = cellAt(p, order, tPrev, st);
  events.push({ t: startMs, cell: cPrev });
  for (let i = 1; ; i++) {
    const t = Math.min(startMs + i * stepMs, endMs);
    if (t === tPrev) break;
    const c = cellAt(p, order, t, st);
    if (c !== cPrev) resolve(p, order, tPrev, cPrev, t, c, st, events);
    tPrev = t;
    cPrev = c;
    if (t >= endMs) break;
  }
  const runs: Run[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.cell === NO_CELL) continue;
    const tOut = i + 1 < events.length ? events[i + 1]!.t : endMs;
    if (tOut > e.t) runs.push({ cell: e.cell, tIn: e.t, tOut });
  }
  return runs;
}

/** Split runs at bucket boundaries so each row belongs to exactly one bucket. */
export function splitAtBuckets(runs: Run[], bucketMs: number): Array<Run & { bucket: number }> {
  const out: Array<Run & { bucket: number }> = [];
  for (const r of runs) {
    let t = r.tIn;
    while (t < r.tOut) {
      const b = Math.floor(t / bucketMs) * bucketMs;
      const e = Math.min(r.tOut, b + bucketMs);
      out.push({ bucket: b, cell: r.cell, tIn: t, tOut: e });
      t = e;
    }
  }
  return out;
}
