import { simClock } from '../time/SimClock';
import type { Slice, TimeSlice } from './types';

export const createTimeSlice: Slice<TimeSlice> = (set) => ({
  simRate: 1,
  simTimeMs: Date.now(),
  viewMode: 'live',
  wallClockMs: Date.now(),
  scrubberMode: false,
  setSimRate: (rate) =>
    set((state) => {
      simClock.setRate(rate);
      state.triggerSimTimeJump?.();
      // Leaving rate 1 means we're no longer tracking the live present.
      return {
        simRate: rate,
        simTimeMs: simClock.now(),
        viewMode: rate !== 1 ? 'review' : state.viewMode,
      };
    }),
  setSimTimeMs: (ms) => set({ simTimeMs: ms }),
  setWallClockMs: (ms) => set({ wallClockMs: ms }),
  setScrubberMode: (on) => set({ scrubberMode: on }),
  jumpToSimTime: (date) =>
    set((state) => {
      simClock.jumpTo(date);
      state.triggerSimTimeJump?.();
      return { simTimeMs: simClock.now() };
    }),
  reviewAt: (date) =>
    set((state) => {
      simClock.jumpTo(date);
      state.triggerSimTimeJump?.();
      return { simTimeMs: simClock.now(), viewMode: 'review' };
    }),
  scrubPreview: (date) =>
    set((state) => {
      // Move the view-clock (the sky follows every frame) WITHOUT the heavy snap/
      // reconcile. Satellites get a day-aware throttled snap via the Engine hook;
      // the full reseed happens on release (reviewAt).
      simClock.jumpTo(date);
      state.triggerScrubPreview?.();
      return { simTimeMs: simClock.now(), viewMode: 'review' };
    }),
  goLive: () =>
    set((state) => {
      simClock.reset();
      state.triggerSimTimeJump?.();
      return { simRate: 1, simTimeMs: simClock.now(), viewMode: 'live' };
    }),
  returnToPresent: () =>
    set((state) => {
      // Prefer the Engine's eased glide; fall back to an instant snap when no engine
      // is attached (e.g. before bootstrap). The glide calls goLive() on landing.
      if (state.triggerReturnToPresent) {
        state.triggerReturnToPresent();
        return {};
      }
      simClock.reset();
      state.triggerSimTimeJump?.();
      return { simRate: 1, simTimeMs: simClock.now(), viewMode: 'live' };
    }),
  resetSimClock: () =>
    set((state) => {
      // Thin alias of goLive — snap to the live present.
      simClock.reset();
      state.triggerSimTimeJump?.();
      return { simRate: 1, simTimeMs: simClock.now(), viewMode: 'live' };
    }),
});
