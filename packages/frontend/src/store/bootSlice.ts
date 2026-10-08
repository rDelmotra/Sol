import type { BootSlice, Slice } from './types';

export const createBootSlice: Slice<BootSlice> = (set) => ({
  loadingPhase: 'fetching',
  loadingError: null,
  setLoadingPhase: (phase) => set({ loadingPhase: phase }),
  setLoadingError: (error) => set({ loadingError: error }),
});
