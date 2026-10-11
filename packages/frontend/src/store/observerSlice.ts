import type { ObserverSlice, Slice } from './types';

export const createObserverSlice: Slice<ObserverSlice> = (set) => ({
  observerLocation: null,
  vantage: 'orbit',
  skyLens: 'all',
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
  // Standing on the ground, lens 'all' is a broken view, not a useful one.
  // DomeSkyLayer is a background (depthWrite false, renderOrder -1000), so it
  // occludes nothing: without a horizon gate the objects beneath your feet draw
  // over the sea, below the horizon line. The setters hold that invariant.
  setVantage: (vantage) =>
    set((s) => ({
      vantage,
      skyLens: vantage === 'ground' && s.skyLens === 'all' ? 'horizon' : s.skyLens,
    })),
  setSkyLens: (lens) =>
    set((s) => ({ skyLens: s.vantage === 'ground' && lens === 'all' ? 'horizon' : lens })),
  setObserverHeadingRad: (rad) => set({ observerHeadingRad: rad }),
  setVisualListState: (visualList) => set({ visualList }),
});
