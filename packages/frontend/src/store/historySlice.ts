import { getReplayClient } from '../data/replay-client';
import type { HistorySlice, Slice } from './types';

/** Events listed per day (a breakup day can carry hundreds of new pieces). */
export const REPLAY_EVENTS_LIMIT = 500;

export const createHistorySlice: Slice<HistorySlice> = (set, get) => ({
  historyCoverage: null,
  historyDay: null,
  historyLoading: false,
  planetarium: false,
  setHistoryCoverage: (coverage) =>
  set({ historyCoverage: coverage }),
  setHistoryDay: (day) => set({ historyDay: day }),
  setHistoryLoading: (loading) => set({ historyLoading: loading }),
  setPlanetarium: (on) => set({ planetarium: on }),

  replayRange: null,
  replayDay: null,
  replayAccuracy: null,
  replaySgpCount: 0,
  replayFragments: null,
  replayEventsByDay: {},
  replayEventsStatus: {},
  setReplayRange: (range) => set({ replayRange: range }),
  setReplayLoaded: ({ day, accuracy, sgpCount }) =>
    set({ replayDay: day, replayAccuracy: day ? accuracy : null, replaySgpCount: day ? sgpCount : 0 }),
  setReplayFragments: (f) => set({ replayFragments: f }),
  loadReplayEvents: async (day) => {
    const status = get().replayEventsStatus[day];
    if (status === 'loading' || status === 'ready') return;
    set((s) => ({ replayEventsStatus: { ...s.replayEventsStatus, [day]: 'loading' } }));
    const events = await getReplayClient().events({ from: day, to: day, limit: REPLAY_EVENTS_LIMIT });
    set((s) => ({
      replayEventsByDay: events ? { ...s.replayEventsByDay, [day]: events } : s.replayEventsByDay,
      replayEventsStatus: { ...s.replayEventsStatus, [day]: events ? 'ready' : 'unavailable' },
    }));
  },
});
