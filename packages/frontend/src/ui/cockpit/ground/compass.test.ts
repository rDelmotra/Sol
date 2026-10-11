import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pass } from '../../../sky/passes';
import { edgeMark, riseSetBearings, spanPosition, visibleTicks, wrapDelta } from './compass';

describe('compass geometry', () => {
  it('wrapDelta wraps both ways', () => {
    assert.equal(wrapDelta(-190), 170);
    assert.equal(wrapDelta(10 - 350), 20);
    assert.equal(wrapDelta(190), -170);
  });
  it('heading sits mid-strip; the edges are ±70°', () => {
    assert.equal(spanPosition(90, 90), 50);
    assert.equal(spanPosition(160, 90), 100);
    assert.equal(spanPosition(161, 90), null);
    assert.equal(spanPosition(5, 355), 50 + (10 / 140) * 100);
  });
  it('ticks: only those in span, N labelled, 45s major', () => {
    const t = visibleTicks(0);
    assert.ok(t.every((x) => Math.abs(x.xPct - 50) <= 50));
    assert.equal(t.find((x) => x.deg === 0)?.label, 'N');
    assert.equal(t.find((x) => x.deg === 15)?.major, false);
    assert.equal(t.find((x) => x.deg === 45)?.major, true);
    assert.equal(visibleTicks(180).find((x) => x.deg === 0), undefined);
  });
  it('edgeMark: on the strip, or an arrow toward the side it lies', () => {
    assert.equal(edgeMark(null, 0), null);
    assert.deepEqual(edgeMark(0, 0), { kind: 'on', xPct: 50 });
    assert.deepEqual(edgeMark(90, 0), { kind: 'off', side: 'right' });
    assert.deepEqual(edgeMark(270, 0), { kind: 'off', side: 'left' });
  });
});

describe('riseSetBearings', () => {
  const pass = (over: Partial<Pass>): Pass =>
    ({ horizonAosMs: 1, horizonLosMs: 2, aosAzimuthDeg: 300, losAzimuthDeg: 120, startClipped: false, endClipped: false, ...over }) as Pass;
  const at = (ms: number) => (ms === 1 ? 290 : null);
  it('uses the horizon bearing, falling back to the stored one', () => {
    assert.deepEqual(riseSetBearings(pass({}), at), { rise: 290, set: 120 });
  });
  it('a clipped end gets no marker', () => {
    assert.deepEqual(riseSetBearings(pass({ startClipped: true }), at), { rise: null, set: 120 });
    assert.deepEqual(riseSetBearings(pass({ endClipped: true }), at), { rise: 290, set: null });
    assert.deepEqual(riseSetBearings(null, at), { rise: null, set: null });
  });
});
