import type { CatalogType } from '../data/types';
import { emptyFacetCounts } from '../data/types';
import type { OrbitalStatus, Purpose } from '@orbitwatch/contracts';
import type { SectorFilterKey } from '../data/metadata-types';
import { reconcileFilterSlices } from '../query/apply';
import type { FilterSlice, Slice } from './types';

const ALL_TYPE_ON: Record<CatalogType, boolean> = {
  satellite: true, rocket_body: true, debris: true, unknown: true, deep_space: true,
};
const ALL_STATUS_ON: Record<OrbitalStatus, boolean> = {
  in_orbit: true, decayed: true, deorbited: true, beyond_earth: true, exploded: true, unknown: true,
};
const ALL_SECTOR_ON: Record<SectorFilterKey, boolean> = {
  commercial: true, government: true, military: true, civil: true, unspecified: true,
};
const ALL_PURPOSE_ON: Record<Purpose, boolean> = {
  communications: true, earth_observation: true, navigation: true, technology_dev: true,
  space_science: true, space_observation: true, surveillance: true, meteorological: true, other: true,
};

export const createFilterSlice: Slice<FilterSlice> = (set, get) => ({
  categoryFilters: {
    active_satellite: true,
    inactive_satellite: true,
    rocket_body: true,
    debris: true,
    unknown: true,
    deep_space: true,
  },
  regimeFilters: { LEO: true, MEO: true, GEO: true, HEO: true, OTHER: true },
  visibleCategoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  },
  visibleRegimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },

  colorBy: 'type',
  typeFilters: { ...ALL_TYPE_ON },
  statusFilters: { ...ALL_STATUS_ON },
  sectorFilters: { ...ALL_SECTOR_ON },
  purposeFilters: { ...ALL_PURPOSE_ON },
  countryFilter: { mode: 'all' },
  programFilter: { mode: 'all' },
  launchFilter: { mode: 'all' },
  ownerFilter: { mode: 'all' },
  visibleFacetCounts: emptyFacetCounts(),

  toggleCategoryFilter: (category) =>
    set((state) => ({
      categoryFilters: {
        ...state.categoryFilters,
        [category]: !state.categoryFilters[category],
      },
    })),
  toggleRegimeFilter: (regime) =>
    set((state) => ({
      regimeFilters: {
        ...state.regimeFilters,
        [regime]: !state.regimeFilters[regime],
      },
    })),
  setVisibleCounts: (catCounts, regCounts) =>
    set({ visibleCategoryCounts: catCounts, visibleRegimeCounts: regCounts }),

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
