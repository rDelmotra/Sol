import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FrameGovernorInputs } from './render/frame-governor';
import { frameIntervalMs } from './render/frame-governor';
import { pacerFlags, type PacerState } from './frame-pacer';

const calm: PacerState = {
  loadingPhase: 'ready',
  historyLoading: false,
  scrubberMode: false,
  viewMode: 'live',
  cameraMode: 'free',
  vantage: 'orbit',
};
const flags = (s: Partial<PacerState>, gliding = false) => {
  const out: Pick<FrameGovernorInputs, 'scrubbing' | 'cameraBusy' | 'groundView' | 'loading'> = {
    scrubbing: true, cameraBusy: true, groundView: true, loading: true, // stale values must be overwritten
  };
  pacerFlags({ ...calm, ...s }, gliding, out);
  return out;
};

describe('pacerFlags', () => {
  it('a ready, live, free-orbit cockpit has every flag off', () => {
    assert.deepEqual(flags({}), { scrubbing: false, cameraBusy: false, groundView: false, loading: false });
  });
  it('time scrubber open, review mode, or the glide to live: scrubbing', () => {
    assert.equal(flags({ scrubberMode: true }).scrubbing, true);
    assert.equal(flags({ viewMode: 'review' }).scrubbing, true);
    assert.equal(flags({}, true).scrubbing, true);
  });
  it('flying, following (follow and joyride) and returning: camera busy', () => {
    for (const cameraMode of ['flying', 'following', 'returning']) assert.equal(flags({ cameraMode }).cameraBusy, true, cameraMode);
  });
  it('ground vantage: ground view', () => {
    assert.equal(flags({ vantage: 'ground' }).groundView, true);
  });
  it('boot phases and history fetches: loading', () => {
    for (const loadingPhase of ['fetching', 'initializing', 'propagating']) assert.equal(flags({ loadingPhase }).loading, true, loadingPhase);
    assert.equal(flags({ historyLoading: true }).loading, true);
  });
  it('each flag alone is enough to keep full rate; none of them lets a quiet cockpit idle at 20 fps', () => {
    const base = { nowMs: 100_000, lastActivityMs: 0, simRate: 1, windowFocused: true, forceFull: false };
    assert.equal(frameIntervalMs({ ...base, ...flags({}) }), 50);
    for (const s of [{ scrubberMode: true }, { cameraMode: 'following' }, { vantage: 'ground' }, { loadingPhase: 'fetching' }]) {
      assert.equal(frameIntervalMs({ ...base, ...flags(s) }), 0, JSON.stringify(s));
    }
  });
});
