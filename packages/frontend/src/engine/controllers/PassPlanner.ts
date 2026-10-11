// ============================================================
// PassPlanner — keeps the store's pass plan in step with the selected object.
//
// A controller owned by the Engine, not a layer or a hook: the sky arc (engine)
// and the pass readout (UI) need the same answer, and layers never import each
// other. Computing once here and publishing to the store gives both one source
// of truth, and it runs whether or not any React component is mounted.
//
// Not per frame: a 24-hour search is about a thousand SGP4 propagations. It
// re-runs only when an input that changes the answer changes — the selection,
// the observer, the vantage, or the sim clock moving into a new 5-minute bucket
// (scrubs and time warp move the clock far on their own).
//
// Runs on the main thread for now. See state/OPEN.md: it should move to a worker.
// ============================================================

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

/** The store fields that decide the plan. `bucket` is the sim-time bucket, not raw time. */
export interface PassPlanInputs {
  selected: EnrichedTLEObject | null;
  observer: GeodeticObserver | null;
  vantage: Vantage;
  bucket: number;
}

export function passPlanInputsOf(state: {
  selectedSatellite: EnrichedTLEObject | null;
  observerLocation: GeodeticObserver | null;
  vantage: Vantage;
  simTimeMs: number;
}): PassPlanInputs {
  return {
    selected: state.selectedSatellite,
    observer: state.observerLocation,
    vantage: state.vantage,
    bucket: Math.floor(state.simTimeMs / PLAN_STALE_MS),
  };
}

/** True when any input that changes the answer differs. Null `prev` means "never computed". */
export function passPlanInputsChanged(prev: PassPlanInputs | null, next: PassPlanInputs): boolean {
  return (
    prev === null ||
    prev.selected !== next.selected ||
    prev.observer !== next.observer ||
    prev.vantage !== next.vantage ||
    prev.bucket !== next.bucket
  );
}

/**
 * Recomputes the pass plan when its inputs change, outside the frame loop (a
 * store subscription, not a per-frame read). One compute per trigger.
 */
export class PassPlanner {
  private last: PassPlanInputs | null = null;
  private unsub: (() => void) | null = null;

  start(): void {
    if (this.unsub) return;
    this.refresh();
    this.unsub = useStore.subscribe(() => this.refresh());
  }

  private refresh(): void {
    const state = useStore.getState();
    const inputs = passPlanInputsOf(state);
    if (!passPlanInputsChanged(this.last, inputs)) return;
    this.last = inputs;
    const { passes, status } = computePassPlan(inputs.selected, inputs.vantage, inputs.observer, simClock.now());
    // Skip an empty-for-the-same-reason rewrite; it would notify every subscriber.
    if (passes.length === 0 && state.nextPasses.length === 0 && state.passStatus === status) return;
    state.setPassPlan(passes, status);
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    this.last = null;
  }
}
