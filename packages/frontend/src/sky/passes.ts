// ============================================================
// Pass prediction — when a satellite is above an observer's horizon, and where
// to look.
//
// WHY THIS IS ITS OWN MODULE: the render side already answers "is this object
// above the horizon RIGHT NOW" (SatelliteRenderer's lens branches, and
// elevationDeg in the analytic layer). A pass is a different question — it is
// an INTERVAL, found by searching time rather than sampling it, and it carries
// things no instantaneous test produces: rise and set bearings, the moment and
// height of culmination.
//
// The analytic layer's `timeScan` stage can already answer "minutes until X
// rises" and is deliberately NOT reused here: it is capped at five objects,
// steps in whole minutes, and returns a single crossing rather than an interval
// with a peak. Whole-minute resolution is far too coarse for an AOS — a LEO
// object crosses ten degrees in seconds.
//
// METHOD: step coarsely to find sign changes in (elevation − threshold), then
// bisect each crossing to second accuracy, and ternary-search the bracketed
// interior for culmination. Coarse steps must stay well under the shortest pass
// worth reporting or a whole pass can fall between two samples.
//
// ONE ELEVATION MODEL: satellite.js only propagates (TEME km). The state is
// converted with orbital-core stateFromKm and the look angles come from
// orbital-core azimuthElevation + observerTeme — the same WGS84 observer the
// analytic layer uses. satellite.js's own ecfToLookAngles (WGS72) is not used;
// the small gap between the two is accepted (state/DECISIONS.md D4).
//
// SAFETY: every propagation is gated on orbital-core withinPropagationWindow.
// satellite.js integrates resonant deep-space orbits from epoch in fixed
// 720-minute steps, so propagation cost grows with distance from epoch — an
// ungated search loop is exactly the shape that previously wedged the SGP4
// worker. See packages/orbital-core/src/propagation-window.ts.
// ============================================================

import { json2satrec, propagate, type OMMJsonObject, type SatRec } from 'satellite.js';
import {
  azimuthElevation,
  julianDate,
  observerTeme,
  stateFromKm,
  withinPropagationWindow,
  type AzElLook,
} from '@orbitwatch/orbital-core';

/** Where the observer stands. Altitude in kilometres above the ellipsoid. */
export interface PassObserver {
  latDeg: number;
  lonDeg: number;
  altKm: number;
}

/**
 * Why a pass plan has nothing to show. Every one of these renders as an empty
 * `Pass[]`, so without the label a correct answer ("this object never rises
 * from here") is indistinguishable from a broken feature. Published alongside
 * the list so the UI can say which it is.
 */
export type PassStatus =
  /** At least one pass found. */
  | 'ok'
  /** Nothing is locked — there is no object to have passes. */
  | 'no-selection'
  /** No observer location — "over you" has no meaning yet. */
  | 'no-location'
  /** In orbit, not standing anywhere. Passes are a ground-observer idea. */
  | 'not-on-ground'
  /** Searched the full horizon and found no crossing. Usually the honest
   *  answer: an object whose inclination is below your latitude never rises. */
  | 'none-found';

/** A single horizon-to-horizon appearance. */
export interface Pass {
  /** Acquisition of signal — crossing up through the threshold. Epoch ms. */
  aosMs: number;
  /** Loss of signal — crossing back down. Epoch ms. */
  losMs: number;
  /**
   * The 0° crossings bracketing this pass: when the object clears the geometric
   * horizon and when it drops back below it. Always `horizonAosMs <= aosMs` and
   * `horizonLosMs >= losMs`.
   *
   * WHY SEPARATE FROM aos/los: the geometric event (crossing the horizon) and
   * the quality threshold (usable above 10°) were one number, so a drawn arc
   * began and ended 10° up, hanging in mid-sky with both ends amputated. The
   * arc wants the horizon span; the radio readout wants the 10° span. They are
   * different questions and need different answers.
   *
   * Falls back to `aosMs`/`losMs` when the crossing cannot be found — the edge
   * of the search window, or of the safe propagation window.
   */
  horizonAosMs: number;
  horizonLosMs: number;
  /** Culmination: the instant of greatest elevation. Epoch ms. */
  peakMs: number;
  /** Greatest elevation reached, degrees. */
  peakElevationDeg: number;
  /** Compass bearing at rise, degrees, North→East, [0, 360). */
  aosAzimuthDeg: number;
  /** Compass bearing at culmination — where to actually point. */
  peakAzimuthDeg: number;
  /** Compass bearing at set. */
  losAzimuthDeg: number;
  /**
   * True when the object was already above the threshold at the start of the
   * search window. `aosMs` is then the window start, not a real rise time, and
   * `aosAzimuthDeg` is not a real rise bearing.
   */
  startClipped: boolean;
  /**
   * True when the object was still above the threshold at the end of the
   * search window. `losMs` is then the window end, not a real set time, and
   * `losAzimuthDeg` is not a real set bearing.
   */
  endClipped: boolean;
}

/** Instantaneous look angles from an observer to a satellite (orbital-core's shape). */
export type LookAngles = AzElLook;

/**
 * The elevation a pass must reach to count. Ten degrees is the usual radio
 * convention — below it terrain and noise generally win.
 */
export const DEFAULT_MIN_ELEVATION_DEG = 10;

/** Coarse search step. Must be well under the shortest pass worth finding. */
export const COARSE_STEP_SEC = 30;

/** Bisection stops here; a second is finer than any UI will show. */
export const REFINE_TOLERANCE_SEC = 1;

/**
 * Cap on how far the horizon-crossing walk steps outward from an AOS/LOS
 * bound. Without a cap, an object that never drops back below 0° — e.g. a
 * geostationary satellite sitting above 10° indefinitely — would have the
 * walk step outward forever.
 */
export const MAX_HORIZON_WALK_MS = 30 * 60_000;

/**
 * Look angles at an instant, or null when the object cannot be propagated there
 * — a bad element set, or an instant outside the safe propagation window.
 */
export function lookAnglesAt(omm: OMMJsonObject, observer: PassObserver, atMs: number): LookAngles | null {
  let satrec: SatRec;
  try {
    satrec = json2satrec(omm);
  } catch {
    return null;
  }
  if (!satrec || satrec.error) return null;
  return lookAnglesFromSatrec(satrec, observer, atMs);
}

/**
 * Same as `lookAnglesAt` but takes an already-built satrec, so a search over
 * many instants (findPasses) does not re-parse the element set every step.
 */
function lookAnglesFromSatrec(satrec: SatRec, observer: PassObserver, atMs: number): LookAngles | null {
  // julianDate(NaN) is NaN, which withinPropagationWindow rejects, so a bad
  // instant never reaches the propagator.
  if (!withinPropagationWindow(julianDate(atMs), satrec.jdsatepoch)) return null;

  const pv = propagate(satrec, new Date(atMs));
  const p = pv?.position;
  const v = pv?.velocity;
  if (!p || !v || typeof p === 'boolean' || typeof v === 'boolean' || !Number.isFinite(p.x)) return null;

  const look = azimuthElevation(stateFromKm(p, v), observerTeme(observer, atMs));
  if (!look || !Number.isFinite(look.elevationDeg) || !Number.isFinite(look.azimuthDeg)) return null;
  return look;
}

/**
 * Whether `nowMs` falls inside this pass — measured on the GEOMETRIC horizon
 * span, not the ≥10° window. Between the horizon and the threshold the object
 * is genuinely up, just low; treating that fringe as "no pass" would make the
 * arc and the readout blink out twice per pass, once on the way up and once on
 * the way down.
 */
export function isPassInProgress(pass: Pass, nowMs: number): boolean {
  return nowMs >= pass.horizonAosMs && nowMs <= pass.horizonLosMs;
}

/**
 * The pass worth showing right now: the one in progress if there is one, else
 * the soonest upcoming.
 *
 * WHY THIS LIVES HERE and not in each consumer: the sky arc, the compass
 * markers and the readout must all be talking about the SAME pass. Three
 * private copies of this rule is three chances for them to disagree — and two
 * surfaces silently describing different passes is indistinguishable, on
 * screen, from the feature being broken.
 */
export function pickCurrentPass(passes: Pass[], nowMs: number): Pass | null {
  if (passes.length === 0) return null;
  return passes.find((p) => isPassInProgress(p, nowMs)) ?? passes[0];
}

export interface FindPassesOptions {
  /** Defaults to DEFAULT_MIN_ELEVATION_DEG. */
  minElevationDeg?: number;
  /** Stop after this many; the search ends early once reached. Default 8. */
  maxPasses?: number;
}

/**
 * Every pass overlapping [fromMs, fromMs + horizonMs], in time order.
 *
 * `fromMs` is the VIEW clock, not the wall clock — the app has a time scrubber,
 * and "the next passes" must mean the next passes from wherever the user is
 * looking, not from now.
 *
 * An object already above the threshold at `fromMs` yields a first pass whose
 * `aosMs` is clamped to `fromMs` and which is marked `startClipped`: its rise
 * happened before the window and its azimuth is not a real rise bearing. One
 * still up at the window end is closed at the end and marked `endClipped`.
 *
 * Returns an empty array — never throws — for an unpropagatable object, or one
 * that simply never rises (a GEO satellite seen from a polar site).
 */
export function findPasses(
  omm: OMMJsonObject,
  observer: PassObserver,
  fromMs: number,
  horizonMs: number,
  options?: FindPassesOptions,
): Pass[] {
  try {
    return findPassesImpl(omm, observer, fromMs, horizonMs, options);
  } catch {
    return [];
  }
}

function findPassesImpl(
  omm: OMMJsonObject,
  observer: PassObserver,
  fromMs: number,
  horizonMs: number,
  options?: FindPassesOptions,
): Pass[] {
  let satrec: SatRec;
  try {
    satrec = json2satrec(omm);
  } catch {
    return [];
  }
  if (!satrec || satrec.error) return [];

  const minElevationDeg = options?.minElevationDeg ?? DEFAULT_MIN_ELEVATION_DEG;
  const maxPasses = options?.maxPasses ?? 8;
  const toMs = fromMs + horizonMs;
  const stepMs = COARSE_STEP_SEC * 1000;
  const toleranceMs = REFINE_TOLERANCE_SEC * 1000;

  const sample = (ms: number): LookAngles | null => {
    try {
      return lookAnglesFromSatrec(satrec, observer, ms);
    } catch {
      return null;
    }
  };

  // Generic sign-crossing bisection: works for both AOS (loMargin < 0 → rising)
  // and LOS (loMargin >= 0 → falling) since it just tracks which side of the
  // threshold the lo end started on.
  const bisectCrossing = (loMs: number, hiMs: number, loMargin: number): number => {
    let lo = loMs;
    let hi = hiMs;
    const loBelow = loMargin < 0;
    while (hi - lo > toleranceMs) {
      const mid = (lo + hi) / 2;
      const look = sample(mid);
      if (!look) {
        // No data at the midpoint — likely the edge of the propagation window
        // falling inside this bracket. Stop refining rather than loop forever.
        return mid;
      }
      const midBelow = look.elevationDeg - minElevationDeg < 0;
      if (midBelow === loBelow) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  };

  // Elevation is unimodal within a pass, so ternary search finds culmination
  // without relying on the coarse grid, which can be many degrees off on a
  // fast LEO pass.
  const findPeak = (loMs: number, hiMs: number): { ms: number; look: LookAngles } => {
    let lo = loMs;
    let hi = hiMs;
    const elevAt = (ms: number) => sample(ms)?.elevationDeg ?? -Infinity;
    while (hi - lo > toleranceMs) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (elevAt(m1) < elevAt(m2)) {
        lo = m1;
      } else {
        hi = m2;
      }
    }
    const peakMs = (lo + hi) / 2;
    const look = sample(peakMs) ?? sample(lo) ?? sample(hi);
    return { ms: peakMs, look: look ?? { elevationDeg: minElevationDeg, azimuthDeg: 0, rangeKm: 0 } };
  };

  /**
   * The 0° crossings bracketing a [aos, los] pass found at `minElevationDeg`.
   * Steps outward from each end until elevation goes negative, then bisects.
   * Returns the given bound unchanged when no crossing is reachable — the walk
   * hit MAX_HORIZON_WALK_MS (e.g. a GEO object sitting above 10° indefinitely)
   * or ran off the edge of the safe propagation window.
   */
  const horizonSpan = (aos: number, los: number): { aosMs: number; losMs: number } => {
    // Backward from aos: walk back in COARSE_STEP_SEC steps looking for a
    // sample below 0°, then bisect that bracket down to toleranceMs.
    let horizonAosMs = aos;
    {
      let hiMs = aos;
      let walked = 0;
      let found = false;
      while (walked < MAX_HORIZON_WALK_MS) {
        const loMs = hiMs - stepMs;
        walked += stepMs;
        const loLook = sample(loMs);
        if (!loLook) break; // propagation-window edge — give up cleanly
        if (loLook.elevationDeg < 0) {
          // Bracket [loMs, hiMs]: lo below 0°, hi at/above 0°. Bisect on the
          // sign of elevation itself (crossing zero, not the pass threshold).
          let lo = loMs;
          let hi = hiMs;
          while (hi - lo > toleranceMs) {
            const mid = (lo + hi) / 2;
            const midLook = sample(mid);
            if (!midLook) {
              hi = mid;
              break;
            }
            if (midLook.elevationDeg < 0) {
              lo = mid;
            } else {
              hi = mid;
            }
          }
          horizonAosMs = (lo + hi) / 2;
          found = true;
          break;
        }
        hiMs = loMs;
      }
      if (!found) horizonAosMs = aos;
      // Guarantee horizonAosMs <= aosMs regardless of path taken.
      if (horizonAosMs > aos) horizonAosMs = aos;
    }

    // Forward from los: mirror image.
    let horizonLosMs = los;
    {
      let loMs = los;
      let walked = 0;
      let found = false;
      while (walked < MAX_HORIZON_WALK_MS) {
        const hiMs = loMs + stepMs;
        walked += stepMs;
        const hiLook = sample(hiMs);
        if (!hiLook) break; // propagation-window edge — give up cleanly
        if (hiLook.elevationDeg < 0) {
          // Bracket [loMs, hiMs]: lo at/above 0°, hi below 0°.
          let lo = loMs;
          let hi = hiMs;
          while (hi - lo > toleranceMs) {
            const mid = (lo + hi) / 2;
            const midLook = sample(mid);
            if (!midLook) {
              lo = mid;
              break;
            }
            if (midLook.elevationDeg < 0) {
              hi = mid;
            } else {
              lo = mid;
            }
          }
          horizonLosMs = (lo + hi) / 2;
          found = true;
          break;
        }
        loMs = hiMs;
      }
      if (!found) horizonLosMs = los;
      // Guarantee horizonLosMs >= losMs regardless of path taken.
      if (horizonLosMs < los) horizonLosMs = los;
    }

    return { aosMs: horizonAosMs, losMs: horizonLosMs };
  };

  const passes: Pass[] = [];

  let prevMs = fromMs;
  const startLook = sample(prevMs);
  let prevMargin: number | null = startLook ? startLook.elevationDeg - minElevationDeg : null;

  let inPass = false;
  let aosMs = fromMs;
  let aosAzimuthDeg = 0;
  let startClipped = false;

  if (startLook && prevMargin !== null && prevMargin >= 0) {
    inPass = true;
    aosMs = fromMs;
    aosAzimuthDeg = startLook.azimuthDeg;
    startClipped = true;
  }

  let currentMs = fromMs + stepMs;
  while (currentMs <= toMs && passes.length < maxPasses) {
    const look = sample(currentMs);
    if (look) {
      const margin = look.elevationDeg - minElevationDeg;
      if (prevMargin !== null) {
        if (!inPass && prevMargin < 0 && margin >= 0) {
          const crossMs = bisectCrossing(prevMs, currentMs, prevMargin);
          const crossLook = sample(crossMs);
          inPass = true;
          aosMs = crossMs;
          aosAzimuthDeg = crossLook ? crossLook.azimuthDeg : look.azimuthDeg;
          startClipped = false;
        } else if (inPass && prevMargin >= 0 && margin < 0) {
          const crossMs = bisectCrossing(prevMs, currentMs, prevMargin);
          const crossLook = sample(crossMs);
          const peak = findPeak(aosMs, crossMs);
          const horizon = horizonSpan(aosMs, crossMs);
          passes.push({
            aosMs,
            losMs: crossMs,
            horizonAosMs: horizon.aosMs,
            horizonLosMs: horizon.losMs,
            peakMs: peak.ms,
            peakElevationDeg: peak.look.elevationDeg,
            aosAzimuthDeg,
            peakAzimuthDeg: peak.look.azimuthDeg,
            losAzimuthDeg: crossLook ? crossLook.azimuthDeg : look.azimuthDeg,
            startClipped,
            endClipped: false,
          });
          inPass = false;
          startClipped = false;
        }
      }
      prevMs = currentMs;
      prevMargin = margin;
    }
    currentMs += stepMs;
  }

  if (inPass && passes.length < maxPasses) {
    const closeLook = sample(toMs) ?? sample(prevMs);
    const peak = findPeak(aosMs, toMs);
    const horizon = horizonSpan(aosMs, toMs);
    passes.push({
      aosMs,
      losMs: toMs,
      horizonAosMs: horizon.aosMs,
      horizonLosMs: horizon.losMs,
      peakMs: peak.ms,
      peakElevationDeg: peak.look.elevationDeg,
      aosAzimuthDeg,
      peakAzimuthDeg: peak.look.azimuthDeg,
      losAzimuthDeg: closeLook ? closeLook.azimuthDeg : peak.look.azimuthDeg,
      startClipped,
      endClipped: true,
    });
  }

  return passes;
}
