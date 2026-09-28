// ============================================================
// Live plane — derived quantities from a propagated state vector (TEME,
// earth-radii), plus createLivePlane: a source-agnostic adapter that turns
// any (key, tMs) -> StateEr resolver into the same speed/altitude/subpoint/
// eclipse/elevation/range/darkness/visibility/distance surface that
// frontend query/analytic/live-source.ts and backend
// analytic/providers/sgp4.ts each hand-roll today.
//
// Numerics: every function here reproduces those two call sites' math
// exactly, EXCEPT lookAngles, which is specified (PROJECT_MAP/15 §1) to use
// the observer's already-unit "up" vector (v·up/|v|) instead of re-deriving
// it by normalizing the observer position (v·o/(|v|·|o|)) — the two are the
// same geometric quantity computed via two different arithmetic paths
// (independent trig vs. normalize-by-division), proven equal to <=1e-12
// relative error by the O2 parity dump (/tmp/ow-parity), not by construction.
// ============================================================

import type { Vec3 } from './vec.js';
import { ER_KM, DEG } from './units.js';
import { altitudeKmFromEr, latitudeDegFromEr, type GeodeticInput } from './earth.js';
import { temeToEcef } from './rotation.js';
import { gmst } from './time.js';
import { sunDirection } from './sun.js';
import { observerTeme, type ObserverFrame } from './observer.js';
import { isEclipsed, isObserverDarkFromUp } from './illumination.js';
import { evaluateVisualVisibility } from './visibility.js';

/** A propagated state vector, TEME frame, earth-radii and earth-radii/second. */
export interface StateEr {
  r: Vec3;
  v: Vec3;
}

/** Build a StateEr from a satellite.js-shaped position/velocity in km, km/s. */
export function stateFromKm(pKm: Vec3, vKm: Vec3): StateEr {
  return {
    r: { x: pKm.x / ER_KM, y: pKm.y / ER_KM, z: pKm.z / ER_KM },
    v: { x: vKm.x / ER_KM, y: vKm.y / ER_KM, z: vKm.z / ER_KM },
  };
}

/** The live-plane field names field()/LivePlane.field() understand. */
export const LIVE_PLANE_FIELDS = ['speedKmS', 'altitudeKm', 'latDeg', 'lonDeg', 'eclipsed'] as const;
export type LivePlaneField = (typeof LIVE_PLANE_FIELDS)[number];

/** Speed, km/s, from a state's velocity (earth-radii/s). */
export function speedKmS(s: StateEr): number {
  return Math.sqrt(s.v.x * s.v.x + s.v.y * s.v.y + s.v.z * s.v.z) * ER_KM;
}

/** Altitude, km, from a state's position (earth-radii). */
export function altitudeKm(s: StateEr): number {
  return altitudeKmFromEr(s.r);
}

/**
 * Sub-satellite point: geocentric latitude (null for the zero vector) and
 * longitude in degrees. TEME -> ECEF via rotation.ts temeToEcef + time.ts
 * gmst for longitude; latitude is rotation-about-z invariant, so it's read
 * straight off the TEME position (same as the pre-orbital-core sites, which
 * never rotated for latitude either).
 */
export function subpoint(s: StateEr, tMs: number): { latDeg: number | null; lonDeg: number } {
  const theta = gmst(tMs);
  const ecef = temeToEcef(s.r, theta);
  const lonDeg = Math.atan2(ecef.y, ecef.x) * DEG;
  const latDeg = latitudeDegFromEr(s.r);
  return { latDeg, lonDeg };
}

/**
 * Sine of elevation + range, km, for a state seen from an observer frame:
 * sinElevation = v·up/|v| where v = state position - observer position (both
 * TEME, earth-radii). Null when the two positions coincide (degenerate).
 */
export function lookAngles(s: StateEr, obs: ObserverFrame): { sinElevation: number; rangeKm: number } | null {
  const vx = s.r.x - obs.position.x;
  const vy = s.r.y - obs.position.y;
  const vz = s.r.z - obs.position.z;
  const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (dist === 0) return null;
  const sinElevation = (vx * obs.up.x + vy * obs.up.y + vz * obs.up.z) / dist;
  return { sinElevation, rangeKm: dist * ER_KM };
}

/** Straight-line distance, km, between two states' positions. */
export function distanceKm(a: StateEr, b: StateEr): number {
  const dx = a.r.x - b.r.x;
  const dy = a.r.y - b.r.y;
  const dz = a.r.z - b.r.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * ER_KM;
}

/** The surface createLivePlane returns — one instance per catalog/provider. */
export interface LivePlane<K> {
  /** One of LIVE_PLANE_FIELDS, else null. Null when the state itself is null. */
  field(k: K, name: string, tMs: number): number | boolean | null;
  elevationDeg(k: K, g: GeodeticInput, tMs: number): number | null;
  rangeKm(k: K, g: GeodeticInput, tMs: number): number | null;
  observerDark(g: GeodeticInput, tMs: number): boolean;
  /** `isCurated` is supplied by the caller — this layer owns no curated-list membership. */
  visuallyVisible(k: K, g: GeodeticInput, tMs: number, isCurated: boolean): boolean | null;
  distanceKm(k1: K, k2: K, tMs: number): number | null;
}

/**
 * Build a LivePlane over any keyed state resolver (index-keyed for the
 * frontend's in-memory catalog, noradId-keyed for the backend's providers).
 * Owns the per-instant sun direction + per-(instant, geodetic point) observer
 * frame caches, exactly like live-source.ts / providers/sgp4.ts's private
 * sunCache/obsCache — a whole-catalog scan at one instant computes the sun
 * and each distinct observer location once.
 */
export function createLivePlane<K>(resolveState: (k: K, tMs: number) => StateEr | null): LivePlane<K> {
  let sunCache: { t: number; v: Vec3 } | null = null;
  let obsCache: { t: number; key: string; frame: ObserverFrame } | null = null;

  function sunAt(tMs: number): Vec3 {
    if (!sunCache || sunCache.t !== tMs) {
      sunCache = { t: tMs, v: sunDirection(tMs) };
    }
    return sunCache.v;
  }

  function observerAt(g: GeodeticInput, tMs: number): ObserverFrame {
    const key = `${g.latDeg},${g.lonDeg},${g.altKm ?? 0}`;
    if (!obsCache || obsCache.t !== tMs || obsCache.key !== key) {
      obsCache = { t: tMs, key, frame: observerTeme(g, tMs) };
    }
    return obsCache.frame;
  }

  function lookAnglesFor(k: K, g: GeodeticInput, tMs: number): { sinElevation: number; rangeKm: number } | null {
    const s = resolveState(k, tMs);
    if (!s) return null;
    return lookAngles(s, observerAt(g, tMs));
  }

  return {
    field(k, name, tMs) {
      const s = resolveState(k, tMs);
      if (!s) return null;
      switch (name as LivePlaneField) {
        case 'speedKmS': return speedKmS(s);
        case 'altitudeKm': return altitudeKm(s);
        case 'latDeg': return subpoint(s, tMs).latDeg;
        case 'lonDeg': return subpoint(s, tMs).lonDeg;
        case 'eclipsed': return isEclipsed(s.r, sunAt(tMs));
        default: return null;
      }
    },

    elevationDeg(k, g, tMs) {
      const la = lookAnglesFor(k, g, tMs);
      return la ? Math.asin(Math.max(-1, Math.min(1, la.sinElevation))) * DEG : null;
    },

    rangeKm(k, g, tMs) {
      return lookAnglesFor(k, g, tMs)?.rangeKm ?? null;
    },

    observerDark(g, tMs) {
      const obs = observerAt(g, tMs);
      const sun = sunAt(tMs);
      return isObserverDarkFromUp(obs.up.x, obs.up.y, obs.up.z, sun.x, sun.y, sun.z);
    },

    visuallyVisible(k, g, tMs, isCurated) {
      const s = resolveState(k, tMs);
      if (!s) return null;
      const obs = observerAt(g, tMs);
      const la = lookAngles(s, obs);
      if (!la) return null;
      const sun = sunAt(tMs);
      return evaluateVisualVisibility({
        isCurated,
        elevationSin: la.sinElevation,
        rangeKm: la.rangeKm,
        observerDark: isObserverDarkFromUp(obs.up.x, obs.up.y, obs.up.z, sun.x, sun.y, sun.z),
        satelliteEclipsed: isEclipsed(s.r, sun),
      }).visible;
    },

    distanceKm(k1, k2, tMs) {
      const a = resolveState(k1, tMs);
      const b = resolveState(k2, tMs);
      if (!a || !b) return null;
      return distanceKm(a, b);
    },
  };
}
