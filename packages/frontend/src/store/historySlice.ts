import type { HistorySlice, Slice } from './types';

export const createHistorySlice: Slice<HistorySlice> = (set) => ({
  historyCoverage: null,
  historyStatus: 'unknown',
  historyDay: null,
  historyLoading: false,
  planetarium: false,
  setHistoryCoverage: (coverage) =>
    set({
      historyCoverage: coverage,
      historyStatus: coverage && coverage.from ? 'available' : 'unavailable',
    }),
  setHistoryDay: (day) => set({ historyDay: day }),
  setHistoryLoading: (loading) => set({ historyLoading: loading }),
  setPlanetarium: (on) => set({ planetarium: on }),
});
