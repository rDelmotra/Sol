import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_WINDOW_MS,
  FRAME_SLACK_MS,
  IDLE_FRAME_MS,
  UNFOCUSED_FRAME_MS,
  FrameGovernor,
  frameIntervalMs,
  isActive,
  isPerfFull,
  shouldRunFrame,
  type FrameGovernorInputs,
} from './frame-governor';

/** A quiet, focused, live cockpit that last saw input 10 s ago. */
const idle = (over: Partial<FrameGovernorInputs> = {}): FrameGovernorInputs => ({
  nowMs: 20_000,
  lastActivityMs: 10_000,
  simRate: 1,
  scrubbing: false,
  cameraBusy: false,
  groundView: false,
  loading: false,
  windowFocused: true,
  forceFull: false,
  ...over,
});

describe('frameIntervalMs', () => {
  it('quiet and focused: 20 fps', () => {
    assert.equal(IDLE_FRAME_MS, 50);
    assert.equal(frameIntervalMs(idle()), 50);
  });
  it('quiet but not focused (window visible): 10 fps', () => {
    assert.equal(UNFOCUSED_FRAME_MS, 100);
    assert.equal(frameIntervalMs(idle({ windowFocused: false })), 100);
  });
  it('input in the last 2.5 s: full rate; at exactly 2.5 s it is idle again', () => {
    assert.equal(ACTIVE_WINDOW_MS, 2500);
    assert.equal(frameIntervalMs(idle({ lastActivityMs: 19_999 })), 0);
    assert.equal(frameIntervalMs(idle({ lastActivityMs: 17_501 })), 0);
    assert.equal(frameIntervalMs(idle({ lastActivityMs: 17_500 })), 50);
  });
  it('activity beats the unfocused slowdown', () => {
    assert.equal(frameIntervalMs(idle({ windowFocused: false, lastActivityMs: 19_900 })), 0);
  });
  it('time-lapse, reverse and bad sim rates: full rate; paused and live: may idle', () => {
    for (const simRate of [2, 60, 0.5, -1, -1000, NaN, Infinity]) assert.equal(frameIntervalMs(idle({ simRate })), 0, `rate ${simRate}`);
    for (const simRate of [0, 1]) assert.equal(frameIntervalMs(idle({ simRate })), 50, `rate ${simRate}`);
  });
  it('scrubbing / review, camera flying or following, ground view and loading: full rate', () => {
    for (const k of ['scrubbing', 'cameraBusy', 'groundView', 'loading'] as const) {
      assert.equal(frameIntervalMs(idle({ [k]: true })), 0, k);
      assert.equal(frameIntervalMs(idle({ [k]: true, windowFocused: false })), 0, `${k} unfocused`);
    }
  });
  it('the perf=full escape hatch forces full rate whatever else is true', () => {
    assert.equal(frameIntervalMs(idle({ forceFull: true })), 0);
    assert.equal(frameIntervalMs(idle({ forceFull: true, windowFocused: false })), 0);
  });
});

describe('isActive', () => {
  it('matches frameIntervalMs === 0', () => {
    for (const over of [{}, { simRate: 5 }, { loading: true }, { windowFocused: false }, { lastActivityMs: 19_000 }]) {
      assert.equal(isActive(idle(over)), frameIntervalMs(idle(over)) === 0);
    }
  });
});

describe('shouldRunFrame', () => {
  it('interval 0 always runs; the first frame always runs', () => {
    assert.ok(shouldRunFrame(5, 5, 0));
    assert.ok(shouldRunFrame(0, Number.NEGATIVE_INFINITY, 50));
  });
  it('waits for the interval, less a few ms of slack', () => {
    assert.ok(!shouldRunFrame(1030, 1000, 50));
    assert.ok(!shouldRunFrame(1000 + 50 - FRAME_SLACK_MS - 0.1, 1000, 50));
    assert.ok(shouldRunFrame(1000 + 50 - FRAME_SLACK_MS, 1000, 50));
    assert.ok(shouldRunFrame(1050, 1000, 50));
  });
  it('a clock that went backwards just runs', () => {
    assert.ok(shouldRunFrame(500, 1000, 50));
  });
});

/** Drive the governor with display ticks and count the frames that run in `seconds`. */
function framesRun(refreshHz: number, seconds: number, inputs: (nowMs: number) => FrameGovernorInputs): number {
  const g = new FrameGovernor();
  const tick = 1000 / refreshHz;
  let n = 0;
  for (let t = 0; t < seconds * 1000; t += tick) if (g.shouldRun(inputs(t))) n++;
  return n;
}

describe('FrameGovernor over time', () => {
  const quiet = (over: Partial<FrameGovernorInputs> = {}) => (nowMs: number) => idle({ nowMs, lastActivityMs: -1e9, ...over });
  it('quiet focused window: about 20 frames a second on 60 Hz and on 120 Hz displays', () => {
    assert.ok(Math.abs(framesRun(60, 10, quiet()) - 200) <= 4);
    assert.ok(Math.abs(framesRun(120, 10, quiet()) - 200) <= 4);
    assert.ok(Math.abs(framesRun(144, 10, quiet()) - 200) <= 10);
  });
  it('quiet unfocused window: about 10 frames a second', () => {
    assert.ok(Math.abs(framesRun(60, 10, quiet({ windowFocused: false })) - 100) <= 3);
  });
  it('active: every display tick runs', () => {
    assert.equal(framesRun(60, 5, quiet({ simRate: 10 })), 300);
    assert.equal(framesRun(60, 5, quiet({ forceFull: true })), 300);
  });
  it('input wakes it at once, then it settles back after 2.5 s', () => {
    const g = new FrameGovernor();
    const tick = 1000 / 60;
    const runs: number[] = [];
    for (let t = 0; t < 10_000; t += tick) {
      const lastActivityMs = t >= 4000 ? 4000 : -1e9; // one input burst at 4 s
      if (g.shouldRun(idle({ nowMs: t, lastActivityMs }))) runs.push(t);
    }
    const before = runs.filter((t) => t >= 3000 && t < 4000).length;
    const burst = runs.filter((t) => t >= 4000 && t < 6500).length;
    const after = runs.filter((t) => t >= 7000 && t < 8000).length;
    assert.ok(before <= 21 && before >= 18, `before ${before}`);
    assert.ok(burst >= 148, `burst ${burst}`); // ~150 display ticks in 2.5 s
    assert.ok(after <= 21 && after >= 18, `after ${after}`);
    const first = runs.find((t) => t >= 4000)!;
    assert.ok(first - 4000 <= tick + 1e-6, 'the first full-rate frame is the next tick');
  });
});

describe('isPerfFull', () => {
  it('?perf=full in the URL', () => {
    assert.equal(isPerfFull('?perf=full', null), true);
    assert.equal(isPerfFull('?a=1&perf=full', null), true);
  });
  it('full saved in localStorage', () => {
    assert.equal(isPerfFull('', 'full'), true);
  });
  it('anything else is off', () => {
    assert.equal(isPerfFull('', null), false);
    assert.equal(isPerfFull('?perf=low', null), false);
    assert.equal(isPerfFull('?perf=', null), false);
    assert.equal(isPerfFull('?perfect=full', null), false);
    assert.equal(isPerfFull('', 'low'), false);
  });
});
