import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAD_BINDINGS, isHudPadAction, type HudPadAction, type PadAction } from '../../bindings/bindings';
import { PadCommandRouter, type PadEffects, type PadHudStore } from './pad-commands';

function fake(over: Partial<PadHudStore> = {}) {
  const calls: string[] = [];
  const store: PadHudStore = {
    controlsSheetOpen: false,
    scrubberMode: false,
    scrubFocusOnReset: false,
    reticleCandidateIndex: null,
    selectByIndex: (i) => calls.push(`select:${i}`),
    setControlsSheetOpen: (o) => calls.push(`sheet:${o}`),
    toggleControlsSheet: () => calls.push('toggleSheet'),
    toggleAskBar: () => calls.push('toggleAsk'),
    cycleReticleCandidate: (d) => calls.push(`cycle:${d}`),
    setScrubberMode: (o) => calls.push(`scrubber:${o}`),
    setScrubFocusOnReset: (o) => calls.push(`focusReset:${o}`),
    returnToPresent: () => calls.push('present'),
    ...over,
  };
  const fx: PadEffects = {
    rumble: (ms, w, s) => calls.push(`rumble:${ms},${w},${s}`),
    consumeSelect: () => calls.push('consumeSelect'),
  };
  return { store, calls, fx, router: new PadCommandRouter(() => store) };
}

/** One state per HUD action that makes it do something. Typed over the union, so a new action must be added here. */
const EXPECT: Record<HudPadAction, { state?: Partial<PadHudStore>; calls: string[] }> = {
  lock: { state: { reticleCandidateIndex: 7 }, calls: ['select:7', 'rumble:180,1,1'] },
  start: { calls: ['toggleSheet'] },
  cyclePrev: { calls: ['cycle:-1'] },
  cycleNext: { calls: ['cycle:1'] },
  askBar: { calls: ['toggleAsk'] },
  selectHold: { state: { scrubberMode: true }, calls: ['scrubber:false', 'consumeSelect'] },
  selectTap: { calls: ['scrubber:true'] },
};

describe('PadCommandRouter', () => {
  it('every HUD pad action in the bindings table is routed', () => {
    const hud = (Object.keys(PAD_BINDINGS) as PadAction[]).filter(isHudPadAction);
    assert.deepEqual([...hud].sort(), Object.keys(EXPECT).sort());
    for (const a of hud) {
      const { store, calls, fx, router } = fake(EXPECT[a].state);
      router.handle(a, fx);
      assert.deepEqual(calls, EXPECT[a].calls, a);
      void store;
    }
  });

  it('lock on the ↺ chip returns to the present instead of selecting', () => {
    const { calls, fx, router } = fake({ scrubberMode: true, scrubFocusOnReset: true, reticleCandidateIndex: 3 });
    router.handle('lock', fx);
    assert.deepEqual(calls, ['present', 'focusReset:false']);
  });

  it('lock with no candidate does nothing', () => {
    const { calls, fx, router } = fake();
    router.handle('lock', fx);
    assert.deepEqual(calls, []);
  });

  it('SELECT: tap while scrubbing and hold while not do nothing', () => {
    const open = fake({ scrubberMode: true });
    open.router.handle('selectTap', open.fx);
    const shut = fake();
    shut.router.handle('selectHold', shut.fx);
    assert.deepEqual([...open.calls, ...shut.calls], []);
  });

  it('dismissControlsSheet closes the sheet only when open', () => {
    const shut = fake();
    shut.router.dismissControlsSheet();
    const open = fake({ controlsSheetOpen: true });
    open.router.dismissControlsSheet();
    assert.deepEqual(shut.calls, []);
    assert.deepEqual(open.calls, ['sheet:false']);
  });
});
