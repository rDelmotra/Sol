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
