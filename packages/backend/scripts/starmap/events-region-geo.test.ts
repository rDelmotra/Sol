import test from 'node:test';
import assert from 'node:assert/strict';
import { REGIONS, chordTouchesRegion, chordNeedsWalk, regionContains } from './events.js';

const india = REGIONS[0]!;
const blr = REGIONS.find((r) => r.key === 'bangalore_500km')!;

test('a chord far from India does not touch it; one cutting the southern tip does', () => {
  assert.equal(chordTouchesRegion(india, 40, 20, 41, 22), false);
  assert.equal(chordTouchesRegion(india, 8.5, 76, 8.5, 79.5), true);
});
test('both ends outside India but the chord cuts the corner is detected', () => {
  // south tip of the polygon is near (8, 77.5): go from the sea west of it to the sea east of it
  assert.ok(!regionContains(india, 7, 75) && !regionContains(india, 7, 80));
  assert.equal(chordTouchesRegion(india, 9.2, 75, 9.2, 80.5), true);
});
test('chord entirely inside the polygon, well away from edges, does not touch the boundary', () => {
  assert.ok(regionContains(india, 22, 78) && regionContains(india, 23, 80));
  assert.equal(chordTouchesRegion(india, 22, 78, 23, 80), false);
});
test('circle: crossing the rim is detected, staying outside is not', () => {
  assert.equal(chordTouchesRegion(blr, 12.97, 70, 12.97, 85), true);
  assert.equal(chordTouchesRegion(blr, 30, 70, 30, 85), false);
  assert.equal(chordTouchesRegion(blr, 12.97, 77.5, 12.97, 77.7), false); // inside, far from the rim
});
test('antimeridian wrap does not invent a crossing', () => {
  assert.equal(chordTouchesRegion(india, 10, 179, 10, -179), false);
});

test('walk decision: far chord no, chord grazing a corner yes, absurdly long chord (garbage orbit at 110 km/s) always yes', () => {
  const f = (a: number[], b: number[]) => chordNeedsWalk(Float64Array.from(a), Float64Array.from(b));
  assert.equal(f([-60, 10], [-58, 12]), false); // Southern Ocean
  assert.equal(f([8.5, 76], [8.5, 79.5]), true); // across the tip of India
  assert.equal(f([19, 132], [39, 128]), true); // 2,200 km in one step
});
