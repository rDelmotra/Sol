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

// ── Edge arcs (canopy ribs) ──────────────────────────────────────────────────
// Each arc lives in a 60×360 container centred on its screen edge, drawn in a
// 380×360 svg. Angles in degrees, SVG convention (0 = +x, clockwise).

/** Rib curve radius, svg px. */
export const ARC_R = 320;
/** Tick marks across the rib. */
export const RIB_COUNT = 9;
/** How far each tick slides outward on approach, px. */
export const RIB_SPLAY_PX = 7;
/** Per-tick delay of the splay, rippling out from the centre tick, ms. */
export const RIB_RIPPLE_MS = 25;
/** Circle centre and angular span per side, in the arc svg's px. */
export const ARC_GEOM = {
  left: { cx: 360, cy: 180, start: 162.5, end: 197.5 },
  right: { cx: 20, cy: 180, start: -17.5, end: 17.5 },
} as const;
export const ARC_BOX_W = 60;
export const ARC_BOX_H = 360;
export const ARC_SVG_W = 380;
/** Edge-flush click strip: x 0, top 80 inside the arc box, 56×200. */
export const ARC_HIT_TOP = 80;
export const ARC_HIT_W = 56;
export const ARC_HIT_H = 200;
/** Arc placard inset from the screen edge. */
export const ARC_LABEL_INSET = 12;

// ── Gear sweep (speed gauge on the right rib) ───────────────────────────────
/** The gauge rides this far outside the rib. */
export const GEAR_SWEEP_OFFSET = 16;
/** Dark gap between segments, degrees. */
export const GEAR_SEG_GAP_DEG = 0.55;
/** Gear readout: right inset, and its top below the arc box's centre, px. */
export const GEAR_READOUT_RIGHT = 6;
export const GEAR_READOUT_BELOW_CENTRE = 104;

// ── Side panes ───────────────────────────────────────────────────────────────
/** Distance of both pane stacks from their screen edge. */
export const PANE_EDGE_INSET = 80;
/** Gap between cards in a stack. */
export const PANE_GAP = 12;
export const LEFT_PANE_W = 280;
export const RIGHT_PANE_W = 300;
/** Fan-in delay step between cards, ms (0 / 60 / 120). */
export const PANE_STAGGER_MS = 60;
/** OBJECT SCAN's orbit diagram slot height. */
export const ORBIT_DIAGRAM_H = 128;

// ── Dock ─────────────────────────────────────────────────────────────────────
/** Horizontal padding inside the dock. */
export const DOCK_PAD_X = 24;
/** Location popover: width, and its gap above the dock's top edge. */
export const LOCATION_POPOVER_W = 230;
export const LOCATION_POPOVER_GAP = 6;
