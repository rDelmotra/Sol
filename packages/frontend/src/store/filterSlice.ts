import { allOn, TYPE_KEYS, STATUS_KEYS, SECTOR_KEYS, PURPOSE_KEYS } from '../data/facets';
import type { FilterSlice, Slice } from './types';

export const createFilterSlice: Slice<FilterSlice> = (set) => ({
  regimeFilters: { LEO: true, MEO: true, GEO: true, HEO: true, OTHER: true },

  colorBy: 'type',
  typeFilters: allOn(TYPE_KEYS),
  statusFilters: allOn(STATUS_KEYS),
  sectorFilters: allOn(SECTOR_KEYS),
  purposeFilters: allOn(PURPOSE_KEYS),
  countryFilter: { mode: 'all' },
  programFilter: { mode: 'all' },
  launchFilter: { mode: 'all' },
  ownerFilter: { mode: 'all' },

  toggleRegimeFilter: (regime) =>
    set((state) => ({
      regimeFilters: {
        ...state.regimeFilters,
        [regime]: !state.regimeFilters[regime],
      },
    })),

  toggleTypeFilter: (key) =>
    set((state) => ({ typeFilters: { ...state.typeFilters, [key]: !state.typeFilters[key] } })),
  toggleStatusFilter: (key) =>
    set((state) => ({ statusFilters: { ...state.statusFilters, [key]: !state.statusFilters[key] } })),
  toggleSectorFilter: (key) =>
    set((state) => ({ sectorFilters: { ...state.sectorFilters, [key]: !state.sectorFilters[key] } })),
  togglePurposeFilter: (key) =>
    set((state) => ({ purposeFilters: { ...state.purposeFilters, [key]: !state.purposeFilters[key] } })),
  setCountryFilter: (filter) => set({ countryFilter: filter }),
});
