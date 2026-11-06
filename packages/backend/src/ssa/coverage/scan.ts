// ============================================================
// Exact pass scan of one object over one time window (pure, no worker). Ported from scripts/starmap/coverage-scan.ts and the 'poly'
// flags of coverage-worker.ts (frozen spike), generalised to circles.
//
// "Passed over" = the sub-satellite point (geodetic lat, lon) is inside the region at a sample, for an object whose radius is inside
// the star map's range. Coarse step outside the near zone; a 1 s step on every bracket with a near end, so no pass shorter than the
// coarse step slips between two samples (resolution 1 s). Pass times: first and last in-sample of a pass (+-1 s).
// ============================================================
import { gmst, temeToEcef, geodeticLatAltFromEr, ER_KM, DEG } from '@orbitwatch/orbital-core';
import { contains, isNear, type Region } from './region.js';
import { posAt, windowInCap, type Prop, type RunStats } from './runs.js';
import { R_MIN_KM, R_MAX_KM } from './consts.js';

/** "No pass" from firstInside / anyPassIn (history before 1970 has negative instants, so test with `!== NO_TIME`, never `>= 0`). */
export const NO_TIME = -1;

export interface Flags { inside: boolean; near: boolean }
const NONE: Flags = { inside: false, near: false };

/** Sub-satellite point (geodetic latitude, longitude) of a TEME position (km) at time tMs. */
export function subPoint(x: number, y: number, z: number, tMs: number): { latDeg: number; lonDeg: number } {
  const e = temeToEcef({ x: x / ER_KM, y: y / ER_KM, z: z / ER_KM }, gmst(tMs));
  const g = geodeticLatAltFromEr(e);
  return { latDeg: g.latDeg ?? 0, lonDeg: Math.atan2(e.y, e.x) * DEG };
}

/** The inside / near predicate of a region at a time. */
export function regionFlags(region: Region, st: RunStats): (p: Prop, tm: number) => Flags {
  return (p, tm) => {
    const pos = posAt(p, tm, st);
    if (!pos) return NONE;
    const r = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
    if (r < R_MIN_KM || r > R_MAX_KM) return NONE;
    const sp = subPoint(pos.x, pos.y, pos.z, tm);
    const inside = contains(region, sp.latDeg, sp.lonDeg);
    return { inside, near: inside || isNear(region, sp.latDeg, sp.lonDeg) };
  };
}

/** Pass intervals of one object inside window [a, b], appended to `out` as [start, end, start, end, ...]. */
export function scanWindow(p: Prop, a: number, b: number, stepMs: number, nearStepMs: number, flags: (p: Prop, tm: number) => Flags, out: number[]): void {
  // NaN = "no pass open": instants before 1970 (history) are negative numbers, so -1 / `< 0` cannot mean "none"
  let open = NaN, last = NaN;
  const feed = (tm: number, f: Flags): void => {
    if (f.inside) { if (Number.isNaN(open)) open = tm; last = tm; }
    else if (!Number.isNaN(open)) { out.push(open, last); open = NaN; }
  };
  let t0 = a, f0 = flags(p, t0);
  feed(t0, f0);
  while (t0 < b) {
    const t1 = Math.min(t0 + stepMs, b), f1 = flags(p, t1);
    if ((f0.near || f1.near) && t1 - t0 > nearStepMs) {
      for (let tt = t0 + nearStepMs; tt < t1; tt += nearStepMs) feed(tt, flags(p, tt));
    }
    feed(t1, f1);
    t0 = t1; f0 = f1;
  }
  if (!Number.isNaN(open)) out.push(open, last);
}

/**
 * The time of the first in-sample of any pass inside [a, b] (same sample schedule as scanWindow, so it is positive exactly when
 * scanWindow finds a pass), or -1. Stops at the first hit: the cheap "did it pass at all" test.
 */
export function firstInside(p: Prop, a: number, b: number, stepMs: number, nearStepMs: number, flags: (p: Prop, tm: number) => Flags): number {
  let t0 = a, f0 = flags(p, t0);
  if (f0.inside) return t0;
  while (t0 < b) {
    const t1 = Math.min(t0 + stepMs, b), f1 = flags(p, t1);
    if ((f0.near || f1.near) && t1 - t0 > nearStepMs) {
      for (let tt = t0 + nearStepMs; tt < t1; tt += nearStepMs) if (flags(p, tt).inside) return tt;
    }
    if (f1.inside) return t1;
    t0 = t1; f0 = f1;
  }
  return NO_TIME;
}

export const REFINE_STEP_MS = 20_000;
export const REFINE_NEAR_STEP_MS = 1000;

/** All passes of one object over the windows (flat [start, end, ...]); an object whose elements are out of the +-60 d cap yields none. */
export function passesIn(p: Prop, region: Region, windows: ArrayLike<number>, st: RunStats, stepMs = REFINE_STEP_MS, nearStepMs = REFINE_NEAR_STEP_MS): number[] {
  const flags = regionFlags(region, st), out: number[] = [];
  for (let w = 0; w < windows.length; w += 2) {
    const a = windows[w]!, b = windows[w + 1]!;
    if (!windowInCap(p, a, b)) continue;
    scanWindow(p, a, b, stepMs, nearStepMs, flags, out);
  }
  return out;
}

/** Did the object pass at all in the windows: the time of the first in-sample, or -1. */
export function anyPassIn(p: Prop, region: Region, windows: ArrayLike<number>, st: RunStats, stepMs = REFINE_STEP_MS, nearStepMs = REFINE_NEAR_STEP_MS): number {
  const flags = regionFlags(region, st);
  for (let w = 0; w < windows.length; w += 2) {
    const a = windows[w]!, b = windows[w + 1]!;
    if (!windowInCap(p, a, b)) continue;
    const t = firstInside(p, a, b, stepMs, nearStepMs, flags);
    if (t !== NO_TIME) return t;
  }
  return NO_TIME;
}
