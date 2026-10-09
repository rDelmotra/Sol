import { emptyFacetCounts } from '../data/types';
import { allOn, TYPE_KEYS, STATUS_KEYS, SECTOR_KEYS, PURPOSE_KEYS } from '../data/facets';
import { reconcileFilterSlices } from '../query/apply';
import type { FilterSlice, Slice } from './types';

export const createFilterSlice: Slice<FilterSlice> = (set, get) => ({
  regimeFilters: { LEO: true, MEO: true, GEO: true, HEO: true, OTHER: true },
  visibleRegimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },

  colorBy: 'type',
  typeFilters: allOn(TYPE_KEYS),
  statusFilters: allOn(STATUS_KEYS),
  sectorFilters: allOn(SECTOR_KEYS),
  purposeFilters: allOn(PURPOSE_KEYS),
  countryFilter: { mode: 'all' },
  programFilter: { mode: 'all' },
  launchFilter: { mode: 'all' },
  ownerFilter: { mode: 'all' },
  visibleFacetCounts: emptyFacetCounts(),

  toggleRegimeFilter: (regime) =>
    set((state) => ({
      regimeFilters: {
        ...state.regimeFilters,
        [regime]: !state.regimeFilters[regime],
      },
    })),
  setVisibleCounts: (regCounts) => set({ visibleRegimeCounts: regCounts }),

  setColorBy: (colorBy) => set({ colorBy }),
  toggleTypeFilter: (key) =>
    set((state) => ({ typeFilters: { ...state.typeFilters, [key]: !state.typeFilters[key] } })),
  toggleStatusFilter: (key) =>
    set((state) => ({ statusFilters: { ...state.statusFilters, [key]: !state.statusFilters[key] } })),
  toggleSectorFilter: (key) =>
    set((state) => ({ sectorFilters: { ...state.sectorFilters, [key]: !state.sectorFilters[key] } })),
  togglePurposeFilter: (key) =>
    set((state) => ({ purposeFilters: { ...state.purposeFilters, [key]: !state.purposeFilters[key] } })),
  setCountryFilter: (filter) => set({ countryFilter: filter }),
  applyQueryFilters: (patch) => {
    const s = get();
    const delta = reconcileFilterSlices(
      {
        typeFilters: s.typeFilters,
        statusFilters: s.statusFilters,
        sectorFilters: s.sectorFilters,
        purposeFilters: s.purposeFilters,
        regimeFilters: s.regimeFilters,
        countryFilter: s.countryFilter,
        programFilter: s.programFilter,
        launchFilter: s.launchFilter,
        ownerFilter: s.ownerFilter,
      },
      patch,
    );
    if (Object.keys(delta).length > 0) set(delta);
  },
  clearQueryFilters: () => get().applyQueryFilters({}),
  setVisibleFacetCounts: (counts) =>
    // The satellite render pass counts only TLE objects, so its type.deep_space is
    // always 0. DSOs (the only deep_space objects, owned by a separate layer) are
    // never gated by this pass → keep their count = the maintained total.
    set((state) => ({
      visibleFacetCounts: {
        ...counts,
        type: { ...counts.type, deep_space: state.facetCounts.type.deep_space },
      },
    })),
});
