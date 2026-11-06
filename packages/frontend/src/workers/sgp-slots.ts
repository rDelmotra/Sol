/**
 * SGP dispatch for the SGP4 worker — pure, no worker globals (unit-tested).
 *
 * History replay catalogs carry pre-1980 element sets generated for the ORIGINAL
 * SGP model (no B*; drag lives in ndot/2, nddot/6). Those slots are flagged
 * `propagator: 'sgp'` on the TLE input. The worker still runs the whole batch
 * through WASM SGP4 (or the satellite.js fallback) — one call per tick — and then
 * overwrites just the SGP slots with @orbitwatch/orbital-core's sgp.ts. Counts are
 * small (≤ ~4k objects pre-1980), so a plain JS loop is enough (see report).
 *
 * Output convention matches the SGP4 path: TEME-like frame of the elements, scaled
 * to Earth radii (km / ER_KM); velocity km/s / ER_KM; invalid → zeros + flag 0.
 */

import { ER_KM, sgpElementsFromOmm, sgpInit, sgpPropagate, type SgpRecord } from '@orbitwatch/orbital-core';
import type { TLEInput } from './sgp4-protocol';

export interface SgpSlot {
  /** Index in the batch (position buffer slot). */
  index: number;
  /** Epoch-time quantities; null = unusable elements (slot always invalid). */
  rec: SgpRecord | null;
  /** Element-set epoch, epoch ms. */
  epochMs: number;
}

/** EPOCH (zoneless or 'Z') → epoch ms (UTC). */
export function ommEpochMs(epoch: unknown): number {
  const s = String(epoch ?? '');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

/** The SGP slots of a batch (empty when every object is SGP4 — the live catalog). */
export function buildSgpSlots(tles: readonly TLEInput[]): SgpSlot[] {
  const out: SgpSlot[] = [];
  for (let i = 0; i < tles.length; i++) {
    const t = tles[i];
    if (t.propagator !== 'sgp') continue;
    const omm = t.omm as unknown as Record<string, unknown>;
    out.push({ index: i, rec: sgpInit(sgpElementsFromOmm(omm)), epochMs: ommEpochMs(omm.EPOCH) });
  }
  return out;
}

/**
 * Overwrite the SGP slots at `timestampMs`. Slots outside ±maxTsinceMin of their
 * epoch (or with a failed solution) are marked invalid, like the SGP4 path.
 */
export function propagateSgpSlots(
  slots: readonly SgpSlot[],
  timestampMs: number,
  maxTsinceMin: number,
  positions: Float32Array,
  velocities: Float32Array,
  validFlags: Uint8Array,
): void {
  for (const s of slots) {
    const i3 = s.index * 3;
    const tsince = (timestampMs - s.epochMs) / 60_000;
    const st = s.rec && Number.isFinite(tsince) && Math.abs(tsince) <= maxTsinceMin ? sgpPropagate(s.rec, tsince) : null;
    if (!st) {
      positions[i3] = positions[i3 + 1] = positions[i3 + 2] = 0;
      velocities[i3] = velocities[i3 + 1] = velocities[i3 + 2] = 0;
      validFlags[s.index] = 0;
      continue;
    }
    positions[i3] = st.position[0] / ER_KM;
    positions[i3 + 1] = st.position[1] / ER_KM;
    positions[i3 + 2] = st.position[2] / ER_KM;
    velocities[i3] = st.velocity[0] / ER_KM;
    velocities[i3 + 1] = st.velocity[1] / ER_KM;
    velocities[i3 + 2] = st.velocity[2] / ER_KM;
    validFlags[s.index] = 1;
  }
}
