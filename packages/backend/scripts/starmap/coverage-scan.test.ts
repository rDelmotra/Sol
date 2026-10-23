import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWindow, type Flags } from './coverage-scan.js';
import type { Prop } from './runs.js';

const P = null as unknown as Prop;
// Synthetic object: "near" for t in [30 s, 100 s], "inside" for t in [60.5 s, 63 s] (a 2.5 s graze).
const flags = (_p: Prop, t: number): Flags => ({ inside: t >= 60_500 && t <= 63_000, near: t >= 30_000 && t <= 100_000 });

test('1 s refine inside the near zone catches a graze shorter than the 20 s coarse step', () => {
  const out: number[] = [];
  scanWindow(P, 0, 200_000, 20_000, 1000, flags, out);
  assert.deepEqual(out, [61_000, 63_000]);
});
test('without a near zone the same graze is missed (this was the Mac refine bug)', () => {
  const out: number[] = [];
  scanWindow(P, 0, 200_000, 20_000, 1000, (p, t) => ({ ...flags(p, t), near: false }), out);
  assert.deepEqual(out, []);
});
test('a pass that spans the window end is closed at the window end', () => {
  const out: number[] = [];
  scanWindow(P, 0, 70_000, 20_000, 1000, flags, out);
  assert.deepEqual(out, [61_000, 63_000]);
  const out2: number[] = [];
  scanWindow(P, 0, 62_000, 20_000, 1000, (_p, t) => ({ inside: t >= 50_000, near: t >= 30_000 }), out2);
  assert.deepEqual(out2, [50_000, 62_000]);
});
