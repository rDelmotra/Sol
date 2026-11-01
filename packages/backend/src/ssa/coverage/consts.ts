// ============================================================
// Star-map coverage (Layer 2) — shared constants. Ported from scripts/starmap/coverage-lib.ts (frozen spike; same values).
//
// OWNER RULE: satellites are indexed ONLY in the star map (TEME, which does not rotate with the Earth). There is no Earth-fixed cell
// code for satellites anywhere in this directory. A ground region is rotated INTO the star map per time slice (cover.ts); the
// sub-satellite point is only used to ANSWER a ground question exactly (scan.ts), never to index.
// ============================================================
import { WGS84_A_KM, SHELL_DELTA0 } from '@orbitwatch/orbital-core';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** Objects whose SGP4 output is garbage (a decaying object that flips boxes constantly); removed from the index and from every answer. */
export const FENCED = new Set([54922]);
/** Per-day cap on order-4 star box changes (same as the spike): beyond it the object is not indexed and is ALWAYS a candidate. */
export const STAR_RUN_CAP = 5000;
/** The order at which objects are swept by SGP4; coarser orders are exact parents (cell / 8 per order). */
export const STAR_FINE = 4;
/** Sampling step of the build (10 s, with bisection of box changes down to 1 s). */
export const BUILD_STEP_MS = 10_000;
/** Pairs are packed under the key as key * ID_SHIFT + object index. The spike packed 16 bits (65,536 objects); this is 22 bits. */
export const ID_SHIFT = 4_194_304;

/** Radial range the star map can encode (cellKey returns null outside it). */
export const R_MIN_KM = WGS84_A_KM * Math.exp(-SHELL_DELTA0) * 1.0000001;
export const R_MAX_KM = WGS84_A_KM * Math.exp(7 * SHELL_DELTA0) * 0.9999999;

/** Stored layers: [granularity, order]. Daily orders 3 and 4 are kept forever; hourly order 4 for a rolling window. */
export type Gran = 'day' | 'hour';
export interface LayerId { gran: Gran; order: number }
export const LAYERS: readonly LayerId[] = [
  { gran: 'day', order: 3 },
  { gran: 'day', order: 4 },
  { gran: 'hour', order: 4 },
];
export const PER_DAY: Record<Gran, number> = { day: 1, hour: 24 };
export const PERIOD_MS: Record<Gran, number> = { day: DAY_MS, hour: HOUR_MS };
export const layerName = (l: LayerId): string => `${l.gran}.o${l.order}`;
export const GRAN_ID: Record<Gran, number> = { day: 0, hour: 1 };
