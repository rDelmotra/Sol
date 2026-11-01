// Small SGP4 helpers for the change detection (ported from scripts/starmap/events.ts: posAt, posVelAt, semiMajorKm, jumpMetric).
import * as satellite from 'satellite.js';
import { makeProp, type Prop } from '../encounter.js';
import type { ChangeObject } from './types.js';

export { makeProp };
export type { Prop };

const MU = 398600.4418;
const DAY_MS = 86_400_000;

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

export interface JumpMetric {
  norad: number;
  regime: string;
  name: string;
  prevEpochMs: number;
  newEpochMs: number;
  gapDays: number;
  /** |previous set propagated to the new epoch  -  new set at its epoch|, km */
  dposKm: number;
  /** components along the new orbit: radial, along-track, cross-track (km) */
  dRad: number;
  dAlong: number;
  dCross: number;
  /** semi-major axis change from mean motion (km), new minus old */
  daKm: number;
  /** daKm minus the change drag alone would cause over the gap (the old set's own MEAN_MOTION_DOT; OMM stores ndot/2) */
  residKm: number;
  dIncDeg: number;
  dEcc: number;
}

export function jumpMetric(o0: ChangeObject, o1: ChangeObject): JumpMetric | null {
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

export function jumpMetrics(prev: ChangeObject[], cur: ChangeObject[]): { metrics: JumpMetric[]; failed: number; unchanged: number; both: number } {
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
