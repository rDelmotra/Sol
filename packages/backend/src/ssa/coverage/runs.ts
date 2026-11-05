// ============================================================
// Runs of one object through star-map boxes. Ported from scripts/starmap/runs.ts (frozen spike): sample the TEME position every
// stepMs; when the box changes between two samples, BISECT the bracket down to <= 1 s (a third box at the midpoint recurses on both
// halves, so a clipped corner gets its own run). Failures and out-of-range radii are "no cell" (-1): they end the run, never emitted.
// ============================================================
import { cellKey } from '@orbitwatch/orbital-core';
import { propagateAt, type Prop } from '../encounter.js';

export { makeProp, type Prop } from '../encounter.js';
export const NO_CELL = -1;
export const BISECT_MS = 1000;
/** Same hard cap the live app uses: |t - epoch| <= 60 d. */
export const MAX_TSINCE_MIN = 60 * 1440;

export interface RunStats { propCalls: number; noCell: number }
export const newStats = (): RunStats => ({ propCalls: 0, noCell: 0 });
export interface Run { cell: number; tIn: number; tOut: number }
export type KeyFn = (p: Prop, tMs: number, st: RunStats) => number;

/** True if the whole [startMs, endMs] window is inside the +-60 d tsince cap. */
export function windowInCap(p: Prop, startMs: number, endMs: number): boolean {
  const lim = MAX_TSINCE_MIN * 60_000;
  return Math.abs(startMs - p.epochMs) <= lim && Math.abs(endMs - p.epochMs) <= lim;
}

/** TEME position (km) at tMs, or null on failure. Counts one SGP4 call. */
export function posAt(p: Prop, tMs: number, st: RunStats): { x: number; y: number; z: number } | null {
  st.propCalls++;
  const pv = propagateAt(p, (tMs - p.epochMs) / 60_000);
  const pos = pv ? pv.position : null;
  if (!pos || typeof pos === 'boolean' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) { st.noCell++; return null; }
  return pos;
}

/** Star-map cell key at tMs for `order`, or NO_CELL. */
export function cellAt(p: Prop, order: number, tMs: number, st: RunStats): number {
  const pos = posAt(p, tMs, st);
  if (!pos) return NO_CELL;
  const k = cellKey(order, pos.x, pos.y, pos.z);
  if (k === null) { st.noCell++; return NO_CELL; }
  return k;
}

interface Event { t: number; cell: number }

function resolve(p: Prop, keyAt: KeyFn, tLo: number, cLo: number, tHi: number, cHi: number, st: RunStats, out: Event[]): void {
  if (cLo === cHi) return;
  if (tHi - tLo <= BISECT_MS) { out.push({ t: Math.round((tLo + tHi) / 2), cell: cHi }); return; }
  const tMid = Math.floor((tLo + tHi) / 2);
  const cMid = keyAt(p, tMid, st);
  if (cMid !== cLo) resolve(p, keyAt, tLo, cLo, tMid, cMid, st, out);
  if (cMid !== cHi) resolve(p, keyAt, tMid, cMid, tHi, cHi, st, out);
}

/** Runs of one object over [startMs, endMs], sampled every stepMs and bisected to ~1 s. Clipped to the window. */
export function buildRunsBy(p: Prop, keyAt: KeyFn, startMs: number, endMs: number, stepMs: number, st: RunStats): Run[] {
  const events: Event[] = [];
  let tPrev = startMs;
  let cPrev = keyAt(p, tPrev, st);
  events.push({ t: startMs, cell: cPrev });
  for (let i = 1; ; i++) {
    const t = Math.min(startMs + i * stepMs, endMs);
    if (t === tPrev) break;
    const c = keyAt(p, t, st);
    if (c !== cPrev) resolve(p, keyAt, tPrev, cPrev, t, c, st, events);
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
