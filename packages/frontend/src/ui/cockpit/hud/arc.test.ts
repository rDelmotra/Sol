import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arcPath, gearHue, gearSegmentAngles, ribAngle, ribDelayMs } from './arc';
import { ARC_GEOM, GEAR_SEG_GAP_DEG, RIB_COUNT, RIB_RIPPLE_MS } from '../layout';

describe('cockpit arc geometry', () => {
  it('arcPath: a quarter circle, small-arc, clockwise', () => {
    assert.equal(arcPath(0, 0, 10, 0, 90), `M 10 0 A 10 10 0 0 1 ${10 * Math.cos(Math.PI / 2)} 10`);
  });

  it('arcPath: counter-clockwise when end < start, large flag past 180°', () => {
    assert.match(arcPath(0, 0, 1, 90, 0), / 0 0 0 /);
    assert.match(arcPath(0, 0, 1, 0, 270), / 0 1 1 /);
  });

  it('ribs span the arc end to end; the centre rib has no delay', () => {
    const { start, end } = ARC_GEOM.right;
    assert.equal(ribAngle(0, RIB_COUNT, start, end), start);
    assert.equal(ribAngle(RIB_COUNT - 1, RIB_COUNT, start, end), end);
    assert.equal(ribDelayMs(4, RIB_COUNT, RIB_RIPPLE_MS), 0);
    assert.equal(ribDelayMs(0, RIB_COUNT, RIB_RIPPLE_MS), 100);
    assert.equal(ribDelayMs(8, RIB_COUNT, RIB_RIPPLE_MS), 100);
  });

  it('gear segments fill bottom-up and tile the span with gaps', () => {
    const { start, end } = ARC_GEOM.right;
    const [u0, l0] = gearSegmentAngles(0, 10, start, end, GEAR_SEG_GAP_DEG);
    const [u9, l9] = gearSegmentAngles(9, 10, start, end, GEAR_SEG_GAP_DEG);
    assert.ok(Math.abs(l0 - (end - GEAR_SEG_GAP_DEG / 2)) < 1e-9); // gear 1 at the bottom
    assert.ok(Math.abs(u9 - (start + GEAR_SEG_GAP_DEG / 2)) < 1e-9); // gear 10 at the top
    assert.ok(u0 < l0 && u9 < l9);
    const [, l1] = gearSegmentAngles(1, 10, start, end, GEAR_SEG_GAP_DEG);
    assert.ok(Math.abs(u0 - l1 - GEAR_SEG_GAP_DEG) < 1e-9);
  });

  it('gearHue ramps cyan 200 → amber 55', () => {
    assert.equal(gearHue(0), 'oklch(0.85 0.14 200)');
    assert.equal(gearHue(1), 'oklch(0.85 0.14 55)');
  });
});
