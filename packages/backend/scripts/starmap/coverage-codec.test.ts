import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeList, forEachId, writeCoverage, readCoverage, findCell, GRAN_HOUR } from './coverage-codec.js';

const rt = (ids: number[], n: number) => {
  const e = encodeList(ids, n); const out: number[] = [];
  forEachId(e.bytes, 0, e.bytes.length, e.tag, (i) => out.push(i));
  return { out, tag: e.tag };
};

test('sparse list uses delta varint and round-trips', () => {
  const ids = [0, 5, 6, 300, 32000];
  const r = rt(ids, 32500);
  assert.equal(r.tag, 0); assert.deepEqual(r.out, ids);
});
test('dense list uses bitmap and round-trips', () => {
  const ids = Array.from({ length: 4000 }, (_, i) => i * 2);
  const r = rt(ids, 8000);
  assert.equal(r.tag, 1); assert.deepEqual(r.out, ids);
});
test('file round-trips cells, lists, norad table', () => {
  const norad = [5, 11, 12, 40000, 290027];
  const cells = new Map<number, number[]>([[7, [0, 2, 4]], [100000, [1]], [3, [0, 1, 2, 3, 4]]]);
  const { file } = writeCoverage(123456, norad, [{ gran: GRAN_HOUR, order: 4, cells }]);
  const d = readCoverage(file);
  assert.deepEqual([...d.norad], norad); assert.equal(d.dayStartMs, 123456);
  const c = d.configs[0]!; assert.equal(c.order, 4);
  const i = findCell(c, 100000); const got: number[] = [];
  forEachId(d.buf, c.offs[i]!, c.lens[i]!, c.tags[i]!, (x) => got.push(x));
  assert.deepEqual(got, [1]); assert.equal(findCell(c, 8), -1);
});
