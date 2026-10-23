// SPIKE — not production. Routing table of the planner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, type Avail, type Question } from './ask-plan.js';

const days = ['2026-10-17', '2026-10-18'];
const av = (over: Partial<Avail> = {}): Avail => ({
  derived: { 'close.approach': new Set(days), 'region.pass': new Set(days) }, hourly: new Set(days), daily: new Set(days), storedApproachKm: 1, ...over,
});
const q = (p: Partial<Question>): Question => ({ id: 0, text: '', window: 'instant', kind: 'region-in-time', ...p });

test('instant region question goes to the live window', () => {
  assert.equal(plan(q({}), av()).layer, 'L4');
});
test('one object against all over hours: live coarse filter', () => {
  const p = plan(q({ window: 'hours', kind: 'one-vs-all' }), av());
  assert.equal(p.layer, 'L4');
  assert.match(p.route, /coarse time filter/);
});
test('all-vs-all over a derived day is a lookup, over an underived day the grid', () => {
  assert.equal(plan(q({ window: 'hours', kind: 'all-vs-all', days: ['2026-10-18'], thresholdKm: 1 }), av()).layer, 'L3');
  assert.equal(plan(q({ window: 'hours', kind: 'all-vs-all', days: ['2026-10-19'], thresholdKm: 1 }), av()).layer, 'L4');
});
test('threshold above the stored one is flagged as partial', () => {
  assert.match(plan(q({ window: 'hours', kind: 'all-vs-all', days: ['2026-10-18'], thresholdKm: 5 }), av()).why, /remainder/);
});
test('long ground / box questions use hourly summaries, else daily, else brute force', () => {
  const g = q({ window: 'days', kind: 'region-in-time', days });
  assert.deepEqual([plan(g, av()).layer, plan(g, av()).gran], ['L2', 'hour']);
  assert.equal(plan(g, av({ hourly: new Set() })).gran, 'day');
  assert.equal(plan(g, av({ hourly: new Set(), daily: new Set() })).layer, 'L4');
  assert.equal(plan(q({ window: 'days', kind: 'box-in-time', days }), av()).layer, 'L2');
});
test('a repeated fact over months is a lookup with an L2 cross-check; underived falls to L2', () => {
  const r = q({ window: 'months', kind: 'repeated-fact', days, fact: { kind: 'region.pass', region: 'IN' } });
  assert.equal(plan(r, av()).layer, 'L3+L2');
  assert.equal(plan(r, av({ derived: {} })).layer, 'L2');
});
