// ============================================================
// useNextPasses — keeps the store's pass plan in step with the selected object.
//
// A hook, not a layer: the sky arc (engine) and the pass readout (UI) need the
// same answer, and layers never import each other. Computing once here and
// publishing to the store gives both one source of truth.
//
// Not per frame: a 24-hour search is about a thousand SGP4 propagations. It
// re-runs only when an input that changes the answer changes — the selection,
// the observer, the vantage, or the sim clock moving into a new 5-minute bucket
// (scrubs and time warp move the clock far on their own).
//
// Runs on the main thread for now. See state/OPEN.md: it should move to a worker.
// ============================================================

import { useEffect } from 'react';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore, type Vantage } from '../../store/useStore';
import { findPasses, type Pass, type PassStatus } from '../../sky/passes';
import { simClock } from '../../time/SimClock';
import type { GeodeticObserver } from '../../data/types';

/** How far ahead to look. A day covers every LEO repeat cycle worth showing. */
export const PASS_SEARCH_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Sim-time bucket. Short against the horizon, long against a pass (no mid-pass flicker). */
export const PLAN_STALE_MS = 5 * 60 * 1000;

/**
 * The pass plan for one set of inputs. Each empty case names its own reason, so
 * "never rises from here" does not look like a broken feature.
 */
export function computePassPlan(
  selected: EnrichedTLEObject | null,
  vantage: Vantage,
  observer: GeodeticObserver | null,
  fromMs: number,
): { passes: Pass[]; status: PassStatus } {
  if (!selected) return { passes: [], status: 'no-selection' };
  if (vantage !== 'ground') return { passes: [], status: 'not-on-ground' };
  if (!observer) return { passes: [], status: 'no-location' };
  const passes = findPasses(
    selected.omm,
    { latDeg: observer.lat, lonDeg: observer.lon, altKm: observer.alt },
    fromMs,
    PASS_SEARCH_HORIZON_MS,
  );
  return { passes, status: passes.length > 0 ? 'ok' : 'none-found' };
}

export function useNextPasses(): void {
  const selected = useStore((s) => s.selectedSatellite);
  const observer = useStore((s) => s.observerLocation);
  const vantage = useStore((s) => s.vantage);
  // Bucketed: the 4 Hz clock push re-renders nothing until the bucket changes.
  const bucket = useStore((s) => Math.floor(s.simTimeMs / PLAN_STALE_MS));

  useEffect(() => {
    const { passes, status } = computePassPlan(selected, vantage, observer, simClock.now());
    const state = useStore.getState();
    // Skip an empty-for-the-same-reason rewrite; it would notify every subscriber.
    if (passes.length === 0 && state.nextPasses.length === 0 && state.passStatus === status) return;
    state.setPassPlan(passes, status);
  }, [selected, observer, vantage, bucket]);
}
