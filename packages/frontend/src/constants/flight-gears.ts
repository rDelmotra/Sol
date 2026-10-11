import { ER_KM } from '@orbitwatch/orbital-core';

/**
 * Free-flight speed gears, shared by the engine (flight physics) and the store
 * (initial HUD readout, which cannot import the engine). Leaf module.
 */

/** Metric speed gears (m/s), half-decade steps. */
export const GEARS_MPS = [
  3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000, 3_000_000, 10_000_000, 30_000_000, 100_000_000,
] as const;

/** 0-based default: 1,000 km/s, a brisk cruise. */
export const DEFAULT_GEAR = 5;

export const GEAR_COUNT = GEARS_MPS.length;

/** One scene unit = one Earth radius, in metres. */
export const EARTH_RADIUS_M = ER_KM * 1000;
