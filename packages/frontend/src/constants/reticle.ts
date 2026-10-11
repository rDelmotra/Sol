/**
 * Gamepad reticle geometry, CSS px. ONE home for both sides: the HUD draws the
 * dotted capture ring with this radius and the engine GPU-picks inside exactly
 * this circle around the screen centre. Leaf module: imports nothing.
 */
export const RETICLE_BOX_PX = 108;

/** The spike drew the ring at r=46 in a 180 px box. */
const RING_RADIUS_AT_180 = 46;
const SPIKE_BOX_PX = 180;

/** 46 × 108/180 = 27.6: the ring scaled with the box, so the pick scales with it. */
export const RETICLE_RING_RADIUS_PX = (RING_RADIUS_AT_180 * RETICLE_BOX_PX) / SPIKE_BOX_PX;
