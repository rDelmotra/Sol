// P3 S4 Part A — wire (de)serialization round-trip.
// Spec: my_plans/marvin/p3/S4_ask_route.md "Part A".

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toWireResult, fromWireResult } from './wire.js';
import type { AnalyticResult, ResultMeta } from './types.js';

function meta(overrides?: Partial<ResultMeta>): ResultMeta {
  return {
    interpretation: 'test',
    universe: 'live',
    evaluatedAt: '2026-07-20T00:00:00.000Z',
    matched: 1,
    scanned: 1,
    coverage: [],
    ...overrides,
  };
}

describe('wire — toWireResult/fromWireResult round-trip', () => {
  it('ids shape: Uint32Array <-> number[] survives JSON.stringify/parse', () => {
    const result: AnalyticResult = {
      shape: 'ids',
      ids: Uint32Array.from([25544, 634, 48274]),
      meta: meta({ matched: 3, scanned: 32000 }),
    };
    const wire = toWireResult(result);
    assert.deepEqual(wire.ids, [25544, 634, 48274]);

    const roundTripped = JSON.parse(JSON.stringify(wire));
    const back = fromWireResult(roundTripped);
    assert.ok(back.ids instanceof Uint32Array);
    assert.deepEqual(Array.from(back.ids as Uint32Array), [25544, 634, 48274]);
    assert.deepEqual(back.meta, result.meta);
  });

  it('scalar shape: value passes through, no ids/rows keys present', () => {
    const result: AnalyticResult = { shape: 'scalar', value: 42, meta: meta() };
    const wire = toWireResult(result);
    assert.equal(wire.value, 42);
    assert.equal('ids' in wire, false);
    assert.equal('rows' in wire, false);

    const back = fromWireResult(wire);
    assert.deepEqual(back, result);
  });

  it('scalar shape: value=false survives (falsy, not "absent")', () => {
    const result: AnalyticResult = { shape: 'scalar', value: false, meta: meta() };
    const wire = toWireResult(result);
    assert.equal('value' in wire, true);
    assert.equal(wire.value, false);
    const back = fromWireResult(wire);
    assert.equal(back.value, false);
  });

  it('table shape: rows pass through verbatim', () => {
    const rows = [{ noradId: 25544, name: 'ISS (ZARYA)' }, { noradId: 634, name: 'SYNCOM 2' }];
    const result: AnalyticResult = { shape: 'table', rows, meta: meta({ matched: 2 }) };
    const wire = toWireResult(result);
    assert.deepEqual(wire.rows, rows);
    const back = fromWireResult(wire);
    assert.deepEqual(back.rows, rows);
  });

  it('nested compare round-trips (ids in both the outer and the compare result)', () => {
    const result: AnalyticResult = {
      shape: 'ids',
      ids: Uint32Array.from([1, 2]),
      meta: meta({ matched: 2 }),
      compare: {
        shape: 'ids',
        ids: Uint32Array.from([3, 4, 5]),
        meta: meta({ matched: 3, interpretation: 'compare-branch' }),
      },
    };
    const wire = toWireResult(result);
    assert.ok(wire.compare);
    assert.deepEqual(wire.compare!.ids, [3, 4, 5]);

    const roundTripped = JSON.parse(JSON.stringify(wire));
    const back = fromWireResult(roundTripped);
    assert.deepEqual(Array.from(back.ids as Uint32Array), [1, 2]);
    assert.ok(back.compare);
    assert.deepEqual(Array.from(back.compare!.ids as Uint32Array), [3, 4, 5]);
    assert.equal(back.compare!.meta.interpretation, 'compare-branch');
  });

  it('grouped shape with no ids: fromWireResult does not fabricate an empty ids array', () => {
    const result: AnalyticResult = {
      shape: 'grouped',
      rows: [{ regime: 'LEO', count: 100 }],
      meta: meta(),
    };
    const wire = toWireResult(result);
    assert.equal('ids' in wire, false);
    const back = fromWireResult(wire);
    assert.equal('ids' in back, false);
  });
});
