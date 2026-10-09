import type { DsoSlice, Slice } from './types';

export const createDsoSlice: Slice<DsoSlice> = (set) => ({
  dsoObjects: [],
  dsoEphemerisById: {},
  dsoLabelPositions: [],
  setDsoObjects: (objects) =>
    set((state) => ({
      dsoObjects: objects,
      categoryCounts: { ...state.categoryCounts, deep_space: objects.length },
      // DSOs are the only 'deep_space' objects (TLE catalog has none) — mirror the
      // count into the new type facet (total + visible) so the type filter group agrees.
      facetCounts: {
        ...state.facetCounts,
        type: { ...state.facetCounts.type, deep_space: objects.length },
      },
      visibleFacetCounts: {
        ...state.visibleFacetCounts,
        type: { ...state.visibleFacetCounts.type, deep_space: objects.length },
      },
    })),
  setDsoEphemeris: (dsoId, snapshot) =>
    set((state) => ({
      dsoEphemerisById: { ...state.dsoEphemerisById, [dsoId]: snapshot },
    })),
  setDsoLabelPositions: (positions) => set({ dsoLabelPositions: positions }),
});
