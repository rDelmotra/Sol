// P3 S7 — hollow-answer detector tests. Spec: my_plans/marvin/p3/S7_eval_v2.md Part B.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeLowBasisFields, isHollow, LOW_BASIS_THRESHOLD } from '../../src/eval/hollow.js';

describe('computeLowBasisFields', () => {
  it('keeps only entries below the threshold', () => {
    const fields = computeLowBasisFields([
      { field: 'a', present: 1, total: 1000 },   // 0.1% — below
      { field: 'b', present: 500, total: 1000 }, // 50% — above
      { field: 'c', present: 49, total: 1000 },  // 4.9% — below
      { field: 'd', present: 50, total: 1000 },  // exactly 5% — not below
    ]);
    assert.deepEqual(fields, ['a', 'c']);
  });

  it('ignores zero-total entries (never divides by zero)', () => {
    assert.deepEqual(computeLowBasisFields([{ field: 'a', present: 0, total: 0 }]), []);
  });

  it('returns empty for an empty coverage array', () => {
    assert.deepEqual(computeLowBasisFields([]), []);
  });

  it('threshold constant is 5%', () => {
    assert.equal(LOW_BASIS_THRESHOLD, 0.05);
  });
});

describe('isHollow', () => {
  const base = { matched: 10, lowBasisFields: [], expectedLowBasis: [], isScalar: false, scalarValue: undefined };

  it('matched === 0 is never hollow, regardless of low-basis fields', () => {
    assert.equal(isHollow({ ...base, matched: 0, lowBasisFields: ['x'], expectedLowBasis: [] }), false);
  });

  it('no low-basis fields and non-scalar shape is not hollow', () => {
    assert.equal(isHollow(base), false);
  });

  it('an unacknowledged low-basis field is hollow', () => {
    assert.equal(isHollow({ ...base, lowBasisFields: ['launchMassKg'] }), true);
  });

  it('a low-basis field listed in expectedLowBasis is not hollow', () => {
    assert.equal(isHollow({ ...base, lowBasisFields: ['launchMassKg'], expectedLowBasis: ['launchMassKg'] }), false);
  });

  it('one acknowledged + one unacknowledged field is still hollow (partial ack does not cover)', () => {
    assert.equal(
      isHollow({ ...base, lowBasisFields: ['launchMassKg', 'owner'], expectedLowBasis: ['launchMassKg'] }),
      true,
    );
  });

  it('scalar shape with null value and matched > 0 is hollow (aggregate skipped everything)', () => {
    assert.equal(isHollow({ ...base, isScalar: true, scalarValue: null }), true);
  });

  it('scalar shape with undefined value and matched > 0 is hollow', () => {
    assert.equal(isHollow({ ...base, isScalar: true, scalarValue: undefined }), true);
  });

  it('scalar shape with a real value (including falsy 0/false) is not hollow', () => {
    assert.equal(isHollow({ ...base, isScalar: true, scalarValue: 0 }), false);
    assert.equal(isHollow({ ...base, isScalar: true, scalarValue: false }), false);
    assert.equal(isHollow({ ...base, isScalar: true, scalarValue: '' }), false);
  });

  it('non-scalar shape with a null-ish value field is not hollow (the check is scalar-only)', () => {
    assert.equal(isHollow({ ...base, isScalar: false, scalarValue: null }), false);
  });
});
