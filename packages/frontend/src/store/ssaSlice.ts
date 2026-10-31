import { fetchObjectEncounters } from '../data/ssa-client';
import type { Slice, SsaSlice } from './types';

export const createSsaSlice: Slice<SsaSlice> = (set, get) => ({
  encountersByNorad: {},
  encounterStatusByNorad: {},
  selectedEncounterId: null,
  loadEncounters: async (noradId) => {
    // Already loading or loaded: the client caches per run, and re-asking in the
    // same session would only repeat the answer.
    const status = get().encounterStatusByNorad[noradId];
    if (status === 'loading' || status === 'ready' || status === 'unavailable') return;
    set((s) => ({ encounterStatusByNorad: { ...s.encounterStatusByNorad, [noradId]: 'loading' } }));
    const result = await fetchObjectEncounters(noradId);
    if (result.kind === 'ok') {
      const sorted = [...result.data.encounters].sort((a, b) => Date.parse(a.tca) - Date.parse(b.tca));
      set((s) => ({
        encountersByNorad: { ...s.encountersByNorad, [noradId]: sorted },
        encounterStatusByNorad: { ...s.encounterStatusByNorad, [noradId]: 'ready' },
      }));
      return;
    }
    // 404 = no run yet: an empty list, not a fault. 503 = service off.
    const next = result.kind === 'none' ? 'ready' : result.kind === 'unavailable' ? 'unavailable' : 'error';
    set((s) => ({
      encountersByNorad: result.kind === 'none' ? { ...s.encountersByNorad, [noradId]: [] } : s.encountersByNorad,
      encounterStatusByNorad: { ...s.encounterStatusByNorad, [noradId]: next },
    }));
  },
  selectEncounter: (id) => set((s) => (s.selectedEncounterId === id ? {} : { selectedEncounterId: id })),
});
