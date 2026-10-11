/**
 * Cockpit HUD layout numbers, CSS px. One home, so moving the dock or a pane
 * moves everything that offsets from it. Values match the spike
 * (claude/ui-run-spike-c350c8 @ d1a0c70) at 1512×900; see its
 * ui-reference/GEOMETRY.md. Pure: no React, no store.
 */

/** Bottom dock height. Everything floating at the bottom offsets from it. */
export const DOCK_H = 40;
/** Gap between the dock's top edge and whatever floats just above it. */
export const DOCK_GAP = 12;

/** Inset of the corner readouts (top-left console, top-right telemetry, NAV/AI). */
export const HUD_CORNER_INSET = 24;
/** Top of the centred "ORBITAL / SSA-01" title. */
export const TITLE_TOP = 12;
/** Height the ask bar reserves above the dock; the NAV/AI block sits above it. */
export const ASK_BAR_RESERVE = 72;
/** Bottom of the NAV/AI status block. */
export const STATUS_BOTTOM = DOCK_H + DOCK_GAP + ASK_BAR_RESERVE;

// ── Reticle ──────────────────────────────────────────────────────────────────
// The box size and ring radius come from store/hudSlice.ts (RETICLE_BOX_PX,
// RETICLE_RING_RADIUS_PX), shared with the engine's pick. The drawing is
// authored in a 180-unit viewBox and scaled to the box.

/** Units of the reticle drawing's viewBox. */
export const RETICLE_VIEWBOX = 180;
/** Corner bracket paths in viewBox units. */
export const RETICLE_BRACKETS = [
  'M 20 40 L 20 20 L 40 20',
  'M 160 40 L 160 20 L 140 20',
  'M 20 140 L 20 160 L 40 160',
  'M 160 140 L 160 160 L 140 160',
] as const;
/** Centre plus, px. */
export const RETICLE_PLUS_PX = 10;
/** Gap between the bottom of the reticle box and its label, px. */
export const RETICLE_LABEL_GAP = 20;

/** A screen radius (px) in the reticle viewBox's units, for a box `boxPx` wide. */
export function ringRadiusInViewBox(ringPx: number, boxPx: number): number {
  return (ringPx * RETICLE_VIEWBOX) / boxPx;
}
