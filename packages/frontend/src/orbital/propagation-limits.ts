/**
 * Propagation time-window policy — the single home for "how far from an element-set
 * epoch is it safe + meaningful to propagate?".
 *
 * WHY THIS EXISTS: satellite.js's deep-space propagator integrates *resonant* orbits
 * (GEO 24-h, GPS/GLONASS/Molniya 12-h) from the element-set epoch in FIXED 720-minute
 * steps (lib/propagation/dspace.js). The step count is |tsince| / 720, so the cost of
 * a single propagation grows linearly with how far the view-time is from epoch. Scrub
 * the time machine far enough and each resonant object runs millions of iterations per
 * tick — the SGP4 worker wedges in a synchronous loop (silent, drops from DevTools,
 * never recovers). These bounds make that impossible.
 *
 * Two distinct knobs:
 *  - FUTURE_HORIZON_DAYS — RENDER-side: how far forward satellites still draw (live
 *    elements); beyond it the view goes planetarium (sky only). UX boundary.
 *  - MAX_PROPAGATION_DAYS — WORKER-side HARD cap, SYMMETRIC (past + future): an object
 *    further than this from its epoch is skipped (marked invalid) before propagation,
 *    so the unbounded dspace integration can never run regardless of how a far time
 *    arrived (setInterval-while-hidden, scrub-preview, glide, snap, or a future bug).
 *
 * INVARIANT: FUTURE_HORIZON_DAYS < MAX_PROPAGATION_DAYS — satellites shown inside the
 * horizon are never clipped by the cap.
 */

export const MINUTES_PER_DAY = 1440;
export const MS_PER_DAY = 86_400_000;

/** Render-side: satellites draw this far forward (live elements); beyond → planetarium. */
export const FUTURE_HORIZON_DAYS = 14;

/** Worker-side hard cap (symmetric) on |time since epoch|. Comfortably > the horizon. */
export const MAX_PROPAGATION_DAYS = 60;
export const MAX_TSINCE_MIN = MAX_PROPAGATION_DAYS * MINUTES_PER_DAY;

/** Minutes between a propagation Julian day and an element-set's epoch Julian day. */
export function tsinceMinutes(jdNow: number, jdsatepoch: number): number {
  return (jdNow - jdsatepoch) * MINUTES_PER_DAY;
}

/**
 * True iff propagating an object at `jdNow` is finite AND within ±`capMin` of its
 * element-set epoch. Non-finite (e.g. an Invalid Date → NaN Julian day) is rejected,
 * so wheel-overshoot timestamps can never reach the propagator either.
 */
export function withinPropagationWindow(
  jdNow: number,
  jdsatepoch: number,
  capMin: number = MAX_TSINCE_MIN,
): boolean {
  const t = tsinceMinutes(jdNow, jdsatepoch);
  return Number.isFinite(t) && Math.abs(t) <= capMin;
}
