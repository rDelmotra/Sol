// P3 S0 — server-source.ts adapter conformance tests.
// Spec: my_plans/marvin/p3/S0_contracts_registry.md "Tests" #9-10.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execute, validateProgram } from '@orbitwatch/analytic';
import { createServerSource } from '../../src/analytic/server-source.js';
import type { FieldProvider, FnName } from '../../src/analytic/types.js';

const SPINE = [101, 102, 103];

/** 102 has no name on purpose — exercises null-chaining + coverage. */
const catalogProvider: FieldProvider = {
  id: 'fixture:catalog',
  fields: ['name', 'regime'],
  getField: (noradId, field) => {
    if (field === 'name') return { 101: 'Alpha', 103: 'Charlie' }[noradId as 101 | 103] ?? null;
    if (field === 'regime') return { 101: 'LEO', 102: 'LEO', 103: 'MEO' }[noradId as 101 | 102 | 103] ?? null;
    return null;
  },
};

describe('createServerSource — adapter conformance (real execute())', () => {
  it('index<->noradId mapping, null chaining, meta.coverage end-to-end', () => {
    const fieldChain = new Map([
      ['name', [catalogProvider]],
      ['regime', [catalogProvider]],
    ]);
    const source = createServerSource(SPINE, fieldChain, new Map());

    assert.equal(source.size(), 3);
    assert.equal(source.noradId(0), 101);
    assert.equal(source.noradToIndex(103), 2);
    assert.equal(source.noradToIndex(999), undefined);

    const program = {
      v: 1 as const,
      universe: 'live' as const,
      timeBinding: { mode: 'now' as const },
      interpretation: 'test',
      pipeline: [
        { op: 'filter' as const, where: { op: 'in' as const, field: 'name', values: ['Alpha', 'Charlie'] } },
        { op: 'sort' as const, by: 'name', dir: 'asc' as const },
        { op: 'limit' as const, n: 2 },
      ],
      output: { shape: 'ids' as const },
    };
    const v = validateProgram(program, { nowMs: Date.now() });
    assert.equal(v.ok, true, v.ok ? '' : JSON.stringify(v.issues));

    const outcome = execute(program, { live: source }, { nowMs: Date.now() });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(Array.from(outcome.result.ids!), [101, 103]);
    const nameCoverage = outcome.result.meta.coverage.find((c) => c.field === 'name');
    // 102's name is null — filter scans all 3 rows, only 2 have a name.
    assert.deepEqual(nameCoverage, { field: 'name', present: 2, total: 3 });
  });

  it('descendsFrom with no owner -> false; a fn with no owner -> null', () => {
    const source = createServerSource(SPINE, new Map(), new Map<FnName, FieldProvider>());
    assert.equal(source.descendsFrom(0, 999), false);
    assert.equal(source.elevationDeg(0, { latDeg: 0, lonDeg: 0 }, Date.now()), null);
    assert.equal(source.rangeKm(0, { latDeg: 0, lonDeg: 0 }, Date.now()), null);
    assert.equal(source.observerDark({ latDeg: 0, lonDeg: 0 }, Date.now()), null);
    assert.equal(source.visuallyVisible(0, { latDeg: 0, lonDeg: 0 }, Date.now()), null);
    assert.equal(source.distToKm(0, 102, Date.now()), null);
  });
});
