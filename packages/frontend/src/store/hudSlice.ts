import type { HudSlice, Slice } from './types';

export const createHudSlice: Slice<HudSlice> = (set) => ({
  analysisPanelOpen: false,
  focusPanelOpen: false,
  askBarOpen: false,
  controlsSheetOpen: false,
  locationPopoverOpen: false,
  toggleAnalysisPanel: () => set((state) => ({ analysisPanelOpen: !state.analysisPanelOpen })),
  toggleFocusPanel: () => set((state) => ({ focusPanelOpen: !state.focusPanelOpen })),
  closePanels: () => set({ analysisPanelOpen: false, focusPanelOpen: false }),
  toggleAskBar: () => set((state) => ({ askBarOpen: !state.askBarOpen })),
  setAskBarOpen: (open) => set({ askBarOpen: open }),
  toggleControlsSheet: () => set((state) => ({ controlsSheetOpen: !state.controlsSheetOpen })),
  setControlsSheetOpen: (open) => set({ controlsSheetOpen: open }),
  setLocationPopoverOpen: (open) => set({ locationPopoverOpen: open }),
});
