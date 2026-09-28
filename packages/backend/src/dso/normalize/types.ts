/**
 * DSO normalization contracts.
 *
 * Owns:
 * - OrbitWatch-canonical DSO ephemeris shapes
 * - normalized vector contracts independent of any provider
 *
 * Does not own:
 * - provider fetching
 * - snapshot publishing
 * - HTTP route behavior
 * - imports from TLE-specific types or updater logic
 */

export type CanonicalStateVector = [
  timestampIso: string,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
];
