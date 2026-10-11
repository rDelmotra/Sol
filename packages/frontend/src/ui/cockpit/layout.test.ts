import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RETICLE_BOX_PX, RETICLE_RING_RADIUS_PX } from '../../store/hudSlice';
import { DOCK_GAP, DOCK_H, RETICLE_VIEWBOX, STATUS_BOTTOM, ringRadiusInViewBox } from './layout';

describe('cockpit layout', () => {
  it('NAV/AI status sits above the dock and the ask bar (golden: bottom 124 px)', () => {
    assert.equal(DOCK_H, 40);
    assert.equal(DOCK_GAP, 12);
    assert.equal(STATUS_BOTTOM, 124);
  });

  it('the drawn ring is the picked ring: 46 drawing units in the 108 px box', () => {
    const r = ringRadiusInViewBox(RETICLE_RING_RADIUS_PX, RETICLE_BOX_PX);
    assert.ok(Math.abs(r - 46) < 1e-9);
    // Back to screen px: identical to the engine's pick radius.
    assert.ok(Math.abs((r * RETICLE_BOX_PX) / RETICLE_VIEWBOX - RETICLE_RING_RADIUS_PX) < 1e-9);
  });
});
