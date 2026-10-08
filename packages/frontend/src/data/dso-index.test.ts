import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dsoIndexOf } from './dso-index';
import type { DsoObject } from './dso-types';

const mk = (id: string) => ({ dsoId: id }) as unknown as DsoObject;

test('matches Array.findIndex on random lists incl. duplicates and missing', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let t = 0; t < 200; t++) {
    const n = Math.floor(rnd() * 20);
    const list = Array.from({ length: n }, () => mk(`id${Math.floor(rnd() * 8)}`));
    for (let q = 0; q < 12; q++) {
      const id = `id${q}`;
      assert.equal(dsoIndexOf(list, id), list.findIndex((d) => d.dsoId === id));
    }
  }
});

test('empty list returns -1', () => {
  assert.equal(dsoIndexOf([], 'x'), -1);
});

test('a new array reference invalidates the cache', () => {
  const a = [mk('a'), mk('b')];
  assert.equal(dsoIndexOf(a, 'b'), 1);
  const b = [mk('b'), mk('a')];
  assert.equal(dsoIndexOf(b, 'b'), 0);
  assert.equal(dsoIndexOf(a, 'b'), 1);
});
