import { emptyFacetCounts, cloneFacetCounts } from '../data/types';
import type { CatalogSlice, Slice } from './types';

export const createCatalogSlice: Slice<CatalogSlice> = (set) => ({
  objectCount: 0,
  categoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  },
  dataTimestamp: null,
  catalogData: [],
  regimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },
  facetCounts: emptyFacetCounts(),
  setCatalogInfo: (info) => {
    const facetCounts = info.facetCounts ?? emptyFacetCounts();
    set({
      objectCount: info.objectCount,
      categoryCounts: info.categoryCounts,
      regimeCounts: info.regimeCounts,
      visibleCategoryCounts: { ...info.categoryCounts },
      visibleRegimeCounts: { ...info.regimeCounts },
      facetCounts,
      // At load every object is visible — seed visible = total (deep-cloned so the
      // renderer can mutate visible counts without touching the totals).
      visibleFacetCounts: cloneFacetCounts(facetCounts),
      dataTimestamp: Date.now(),
    });
  },
  setCatalogData: (data) => set({ catalogData: data }),
});
