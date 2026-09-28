import type { DsoSnapshot, CanonicalStateVector } from '@orbitwatch/contracts';

export interface DsoPosition {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface DsoInterpolationOptions {
  validToGraceMs?: number;
}

/**
 * Interpolate a DSO position at a given timestamp from a snapshot's state vectors.
 *
 * - Binary search for the bracketing pair
 * - Linear interpolation between adjacent samples
 * - Clamps to nearest sample at window edges
 * - Returns null once timestamp exceeds validTo + optional grace
 */
export function interpolateDsoPosition(
  snapshot: DsoSnapshot,
  timestampMs: number,
  options: DsoInterpolationOptions = {},
): DsoPosition | null {
  const vectors = snapshot.stateVectors;
  if (vectors.length === 0) return null;

  const validToMs = Date.parse(snapshot.validTo);
  const validToGraceMs = options.validToGraceMs ?? 0;
  if (timestampMs > validToMs + validToGraceMs) return null;

  // Single sample — return it directly
  if (vectors.length === 1) {
    return vecToPosition(vectors[0]);
  }

  const firstMs = Date.parse(vectors[0][0]);
  const lastMs = Date.parse(vectors[vectors.length - 1][0]);

  // Clamp before first sample
  if (timestampMs <= firstMs) {
    return vecToPosition(vectors[0]);
  }

  // Clamp after last sample
  if (timestampMs >= lastMs) {
    return vecToPosition(vectors[vectors.length - 1]);
  }

  // Binary search for the bracket [lo, lo+1] where vectors[lo].t <= timestampMs < vectors[lo+1].t
  let lo = 0;
  let hi = vectors.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (Date.parse(vectors[mid][0]) <= timestampMs) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const v0 = vectors[lo];
  const v1 = vectors[hi];
  const t0 = Date.parse(v0[0]);
  const t1 = Date.parse(v1[0]);
  const dt = t1 - t0;

  if (dt <= 0) return vecToPosition(v0);

  const t = (timestampMs - t0) / dt;

  return {
    x: v0[1] + (v1[1] - v0[1]) * t,
    y: v0[2] + (v1[2] - v0[2]) * t,
    z: v0[3] + (v1[3] - v0[3]) * t,
    vx: v0[4] + (v1[4] - v0[4]) * t,
    vy: v0[5] + (v1[5] - v0[5]) * t,
    vz: v0[6] + (v1[6] - v0[6]) * t,
  };
}

function vecToPosition(v: CanonicalStateVector): DsoPosition {
  return { x: v[1], y: v[2], z: v[3], vx: v[4], vy: v[5], vz: v[6] };
}
