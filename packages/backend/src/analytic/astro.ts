// CANONICAL SOURCE: packages/frontend/src/orbital/{time,coordinates,lighting,visual-visibility}.ts
// Copied under the rule of three — extract packages/orbital-core when a 3rd consumer appears.
//
// The frame simplification: the client pipeline goes equatorial -> scene
// (frames.ts sourceToScene: (x,y,z) -> (x,z,-y)) -> back to TEME in live-source
// ((s.x,-s.z,s.y)). That round trip is the identity, so this file computes
// directly in the equatorial frame and skips both swaps. Same math, same
// numbers, two fewer conventions to carry. See astro.test.ts's golden
// cross-check for the executable proof.

const EARTH_RADIUS_KM = 6371;

export function toJulianDate(tMs: number): number {
  return tMs / 86400000.0 + 2440587.5;
}

/** Greenwich Apparent Sidereal Time in radians (IAU 1982 model). */
export function getGAST(tMs: number): number {
  const jd = toJulianDate(tMs);
  const du = jd - 2451545.0;
  const T = du / 36525.0;
  const gmstDeg = 280.46061837
    + 360.98564736629 * du
    + 0.000387933 * T * T
    - T * T * T / 38710000.0;
  return (((gmstDeg % 360) + 360) % 360) * (Math.PI / 180.0);
}

/** Sun direction as an equatorial (TEME) unit vector. */
export function sunDirTeme(tMs: number): { x: number; y: number; z: number } {
  const jd = toJulianDate(tMs);
  const T = (jd - 2451545.0) / 36525.0;

  const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) * (Math.PI / 180.0);
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * (Math.PI / 180.0);

  const C = ((1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
    + 0.000289 * Math.sin(3 * M)) * (Math.PI / 180.0);

  const sunLon = L0 + C;

  const eps = (23.439291111
    - 0.013004167 * T
    - 0.0000001639 * T * T
    + 0.0000005036 * T * T * T) * (Math.PI / 180.0);

  return {
    x: Math.cos(sunLon),
    y: Math.sin(sunLon) * Math.cos(eps),
    z: Math.sin(sunLon) * Math.sin(eps),
  };
}

/** Observer position in TEME, earth-radii. */
export function observerTeme(
  latDeg: number,
  lonDeg: number,
  altKm: number,
  tMs: number,
): { x: number; y: number; z: number } {
  const lat = latDeg * (Math.PI / 180);
  const lon = lonDeg * (Math.PI / 180);
  const r = (EARTH_RADIUS_KM + altKm) / EARTH_RADIUS_KM;

  const x = r * Math.cos(lat) * Math.cos(lon);
  const y = r * Math.cos(lat) * Math.sin(lon);
  const z = r * Math.sin(lat);

  const theta = getGAST(tMs);
  return {
    x: x * Math.cos(theta) - y * Math.sin(theta),
    y: x * Math.sin(theta) + y * Math.cos(theta),
    z,
  };
}

export function isEclipsedFromComponents(
  satX: number, satY: number, satZ: number,
  sunX: number, sunY: number, sunZ: number,
): boolean {
  const dot = satX * sunX + satY * sunY + satZ * sunZ;
  if (dot >= 0) return false;

  const satLenSq = satX * satX + satY * satY + satZ * satZ;
  const distSq = satLenSq - (dot * dot);
  return distSq < 1.0;
}

const TWILIGHT_SIN = Math.sin(-6 * (Math.PI / 180));

export function isObserverInDarkFromComponents(
  obsX: number, obsY: number, obsZ: number,
  sunX: number, sunY: number, sunZ: number,
): boolean {
  const obsLen = Math.sqrt(obsX * obsX + obsY * obsY + obsZ * obsZ);
  if (obsLen === 0) return false;

  const invObsLen = 1 / obsLen;
  const sinElev = ((obsX * invObsLen) * sunX) + ((obsY * invObsLen) * sunY) + ((obsZ * invObsLen) * sunZ);
  return sinElev < TWILIGHT_SIN;
}

// ── evaluateVisualVisibility — copied from orbital/visual-visibility.ts ───────
// (skipping the dome-mode exports, which the server executor doesn't need).

const DEG_TO_RAD = Math.PI / 180;
export const VISUAL_ELEVATION_THRESHOLD_DEG = 10;
export const VISUAL_ELEVATION_THRESHOLD_RAD = VISUAL_ELEVATION_THRESHOLD_DEG * DEG_TO_RAD;
export const VISUAL_ELEVATION_THRESHOLD_SIN = Math.sin(VISUAL_ELEVATION_THRESHOLD_RAD);
export const VISUAL_RANGE_MAX_KM = 2000;

export interface VisualVisibilityInput {
  isCurated: boolean;
  elevationSin: number;
  rangeKm: number;
  observerDark: boolean;
  satelliteEclipsed: boolean;
  elevationThresholdSin?: number;
  rangeMaxKm?: number;
}

export interface VisualVisibilityResult {
  visible: boolean;
  reason: 'not_curated' | 'below_elevation' | 'out_of_range' | 'observer_daylight' | 'satellite_eclipsed' | null;
}

export function evaluateVisualVisibility(input: VisualVisibilityInput): VisualVisibilityResult {
  const elevationThresholdSin = input.elevationThresholdSin ?? VISUAL_ELEVATION_THRESHOLD_SIN;
  const rangeMaxKm = input.rangeMaxKm ?? VISUAL_RANGE_MAX_KM;

  if (!input.isCurated) return { visible: false, reason: 'not_curated' };
  if (input.elevationSin < elevationThresholdSin) return { visible: false, reason: 'below_elevation' };
  if (input.rangeKm > rangeMaxKm) return { visible: false, reason: 'out_of_range' };
  if (!input.observerDark) return { visible: false, reason: 'observer_daylight' };
  if (input.satelliteEclipsed) return { visible: false, reason: 'satellite_eclipsed' };
  return { visible: true, reason: null };
}

// ── Propagation window — the ONE home is @orbitwatch/orbital-core. Guards the
// SDP4 deep-space resonance wedge. Re-exported until providers/sgp4.ts
// imports orbital-core directly (Phase 2.3 step O3). ──

export { MAX_PROPAGATION_DAYS, MAX_TSINCE_MIN } from '@orbitwatch/orbital-core';
