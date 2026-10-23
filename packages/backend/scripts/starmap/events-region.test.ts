import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRegions, NEAR_SHIFT } from './events-region.js';

// A fake object: inside region 0 only during [a,b); "near" whenever within 40 s of the interval.
const mk = (a: number, b: number) => (t: number): number => {
  const inside = t >= a && t < b ? 1 : 0;
  const near = t > a - 40_000 && t < b + 40_000 ? 1 : 0;
  return inside | (near << NEAR_SHIFT);
};

test('a 3 s graze between two 20 s samples is found with the near-zone fine walk', () => {
  const out: number[] = [];
  scanRegions(7, mk(1_000_000 + 7_000, 1_000_000 + 10_000), 0, 2_000_000, 20_000, 1000, out);
  assert.equal(out.length, 5);
  assert.equal(out[0], 7); assert.equal(out[1], 0);
  assert.ok(Math.abs(out[2]! - 1_007_000) <= 1000, String(out[2]));
  assert.ok(Math.abs(out[3]! - 1_010_000) <= 1000, String(out[3]));
});

test('without the near flag the same graze is missed (this is the bug the fine walk fixes)', () => {
  const f = mk(1_007_000, 1_010_000);
  const out: number[] = [];
  scanRegions(7, (t) => f(t) & 0xff, 0, 2_000_000, 20_000, 1000, out);
  assert.equal(out.length, 0);
});

test('long pass: entry and exit within 1 s, flags clear', () => {
  const out: number[] = [];
  scanRegions(1, mk(500_000, 800_000), 0, 2_000_000, 20_000, 1000, out);
  assert.equal(out.length, 5);
  assert.ok(Math.abs(out[2]! - 500_000) <= 1000 && Math.abs(out[3]! - 800_000) <= 1000);
  assert.equal(out[4], 0);
});

test('pass crossing the window start and end carries the flags', () => {
  const out: number[] = [];
  scanRegions(1, mk(-50_000, 3_000_000), 0, 2_000_000, 20_000, 1000, out);
  assert.deepEqual(out.slice(2), [0, 2_000_000, 3]);
});
