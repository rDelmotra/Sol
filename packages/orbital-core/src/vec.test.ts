import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dot, norm, sub, normalize } from './vec.js';

describe('vec: dot', () => {
  it('computes the dot product', () => {
    assert.equal(dot({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }), 32);
  });

  it('is zero for orthogonal unit vectors', () => {
    assert.equal(dot({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), 0);
  });
});

describe('vec: norm', () => {
  it('computes the euclidean length (3-4-5 triangle)', () => {
    assert.equal(norm({ x: 3, y: 4, z: 0 }), 5);
  });

  it('is zero for the zero vector', () => {
    assert.equal(norm({ x: 0, y: 0, z: 0 }), 0);
  });
});

describe('vec: sub', () => {
  it('subtracts component-wise', () => {
    assert.deepEqual(sub({ x: 5, y: 5, z: 5 }, { x: 1, y: 2, z: 3 }), { x: 4, y: 3, z: 2 });
  });
});

describe('vec: normalize', () => {
  it('returns a unit vector in the same direction', () => {
    const n = normalize({ x: 3, y: 4, z: 0 });
    assert.ok(Math.abs(norm(n) - 1) < 1e-15);
    assert.ok(Math.abs(n.x - 0.6) < 1e-15);
    assert.ok(Math.abs(n.y - 0.8) < 1e-15);
  });

  it('does not NaN on the zero vector — returns zero instead', () => {
    assert.deepEqual(normalize({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
  });
});
