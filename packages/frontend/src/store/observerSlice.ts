import type { ObserverSlice, Slice } from './types';

export const createObserverSlice: Slice<ObserverSlice> = (set) => ({
  observerLocation: null,
  visibilityMode: 'all',
  observerHeadingRad: 0,
  visualList: {
    status: 'loading',
    version: null,
    source: null,
    stale: false,
    count: 0,
    updatedAt: null,
    message: null,
  },
  setObserverLocation: (loc) => set({ observerLocation: loc }),
  setVisibilityMode: (mode) => set({ visibilityMode: mode }),
  setObserverHeadingRad: (rad) => set({ observerHeadingRad: rad }),
  setVisualListState: (visualList) => set({ visualList }),
});
