import type { AnalyticSlice, Slice } from './types';

export const createAnalyticSlice: Slice<AnalyticSlice> = (set, get) => ({
  analyticFilter: { mode: 'all' },
  analyticAnswer: null,
  setAnalyticFilter: (ids) => {
    const cur = get().analyticFilter;
    if (ids === null) {
      if (cur.mode !== 'all') set({ analyticFilter: { mode: 'all' } });
      return;
    }
    if (cur.mode === 'only' && cur.ids.size === ids.size) {
      let same = true;
      for (const id of ids) {
        if (!cur.ids.has(id)) { same = false; break; }
      }
      if (same) return; // reference preserved — no renderer recompute
    }
    set({ analyticFilter: { mode: 'only', ids: new Set(ids) } });
  },
  setAnalyticAnswer: (answer) => set({ analyticAnswer: answer }),
  clearAnalyticAnswer: () => {
    get().setAnalyticFilter(null);
    set({ analyticAnswer: null });
  },
});
