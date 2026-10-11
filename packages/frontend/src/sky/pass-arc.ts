// ============================================================
// Pass arc sampling — the path a pass traces across one observer's sky, in
// EARTH-FIXED coordinates.
//
// WHY EARTH-FIXED: the arc is drawn from the ground. In the inertial TEME frame
// the observer turns with the Earth (~0.25°/min), so a TEME arc drawn at the
// scene root slides away from the horizon it rose from. Rotating every sample
// into ECEF at its own instant pins the arc to the ground: its ends sit on the
// observer's true horizon for as long as the pass is shown. The renderer then
// parents it to the rotating Earth group.
//
// Elevation is computed per sample with orbital-core's WGS84 observer, the same
// model sky/passes.ts uses, so "above the threshold" matches the pass search.
// ============================================================

import { json2satrec, propagate, type OMMJsonObject } from 'satellite.js';
import {
  ER_KM,
  DEG,
  gmst,
  julianDate,
  observerEcef,
  temeToEcef,
  withinPropagationWindow,
} from '@orbitwatch/orbital-core';
import type { PassObserver } from './passes';

export interface PassArcSamples {
  /** ECEF positions in earth-radii, packed x,y,z (z = polar axis, NOT scene Y-up). */
  ecefEr: Float32Array;
  /** Elevation of each sample above the observer's horizon, degrees. */
  elevationDeg: Float32Array;
}

/**
 * `count` evenly spaced samples of the object's position over [startMs, endMs],
 * Earth-fixed. Samples that cannot be propagated copy the nearest good one.
 * Null when nothing in the span propagates.
 */
export function samplePassArc(
  omm: OMMJsonObject,
  observer: PassObserver,
  startMs: number,
  endMs: number,
  count: number,
): PassArcSamples | null {
  if (!(endMs > startMs) || count < 2) return null;
  let satrec;
  try {
    satrec = json2satrec(omm);
  } catch {
    return null;
  }
  if (!satrec || satrec.error) return null;

  const obs = observerEcef(observer);
  const ecefEr = new Float32Array(count * 3);
  const elevationDeg = new Float32Array(count);
  const ok = new Uint8Array(count);
  let firstGood = -1;

  for (let i = 0; i < count; i++) {
    const t = startMs + (i / (count - 1)) * (endMs - startMs);
    if (!withinPropagationWindow(julianDate(t), satrec.jdsatepoch)) continue;
    let p;
    try {
      p = propagate(satrec, new Date(t))?.position;
    } catch {
      continue;
    }
    if (!p || typeof p === 'boolean' || !Number.isFinite(p.x)) continue;
    const e = temeToEcef({ x: p.x / ER_KM, y: p.y / ER_KM, z: p.z / ER_KM }, gmst(t));
    ecefEr[i * 3] = e.x;
    ecefEr[i * 3 + 1] = e.y;
    ecefEr[i * 3 + 2] = e.z;
    const dx = e.x - obs.position.x;
    const dy = e.y - obs.position.y;
    const dz = e.z - obs.position.z;
    const range = Math.hypot(dx, dy, dz);
    const sinEl = range > 0 ? (dx * obs.up.x + dy * obs.up.y + dz * obs.up.z) / range : 1;
    elevationDeg[i] = Math.asin(Math.max(-1, Math.min(1, sinEl))) * DEG;
    ok[i] = 1;
    if (firstGood < 0) firstGood = i;
  }
  if (firstGood < 0) return null;

  // Fill gaps from the nearest earlier good sample (or the first good one at the
  // start), never from the zero vector — that would spear a line out of the core.
  let last = firstGood;
  for (let i = 0; i < count; i++) {
    if (ok[i]) {
      last = i;
      continue;
    }
    ecefEr[i * 3] = ecefEr[last * 3];
    ecefEr[i * 3 + 1] = ecefEr[last * 3 + 1];
    ecefEr[i * 3 + 2] = ecefEr[last * 3 + 2];
    elevationDeg[i] = elevationDeg[last];
  }
  return { ecefEr, elevationDeg };
}
