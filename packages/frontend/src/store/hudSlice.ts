import type { HudSlice, Slice } from './types';

/**
 * Gamepad reticle geometry, CSS px. ONE home for both sides: the HUD draws the
 * dotted capture ring with this radius and the engine GPU-picks inside exactly
 * this circle around the screen centre. (The spike drew r=46 in a 180 px box,
 * then shrank the box to 108 px without moving the pick: 46 × 108/180 = 27.6.)
 */
export const RETICLE_BOX_PX = 108;
export const RETICLE_RING_RADIUS_PX = 27.6;

export const createHudSlice: Slice<HudSlice> = (set) => ({
  analysisPanelOpen: false,
  focusPanelOpen: false,
  askBarOpen: false,
  controlsSheetOpen: false,
  toggleAnalysisPanel: () => set((state) => ({ analysisPanelOpen: !state.analysisPanelOpen })),
  toggleFocusPanel: () => set((state) => ({ focusPanelOpen: !state.focusPanelOpen })),
  closePanels: () => set({ analysisPanelOpen: false, focusPanelOpen: false }),
  toggleAskBar: () => set((state) => ({ askBarOpen: !state.askBarOpen })),
  setAskBarOpen: (open) => set({ askBarOpen: open }),
  toggleControlsSheet: () => set((state) => ({ controlsSheetOpen: !state.controlsSheetOpen })),
  setControlsSheetOpen: (open) => set({ controlsSheetOpen: open }),
});
