import test from 'node:test';
import assert from 'node:assert/strict';
import { classKey, fallbackKeys, fitGrowth, gapBinOf, madSigma, quantile, sortedCopy, bstarBand } from './uncertainty-lib.js';

test('robust sigma of a Gaussian-like sample ignores outliers', () => {
  const a: number[] = [];
  for (let i = 1; i <= 999; i++) a.push(Math.tan(Math.PI * (i / 1000 - 0.5)) * 0 + (i - 500) / 250); // uniform-ish -2..2
  const clean = madSigma(a).sigma;
  a.push(1e9, -1e9, 1e8);
  assert.ok(Math.abs(madSigma(a).sigma - clean) / clean < 0.02);
});
test('quantile interpolates', () => {
  assert.equal(quantile(sortedCopy([1, 2, 3, 4]), 0.5), 2.5);
  assert.equal(quantile(sortedCopy([5]), 0.9), 5);
});
test('growth fit recovers an exact quadratic and never goes negative', () => {
  const t = [0.4, 1, 1.7, 2.4, 4, 6, 8.4, 11.9];
  const y = t.map((x) => 0.2 + 0.5 * x + 0.1 * x * x);
  const f = fitGrowth(t, y, t.map(() => 100));
  assert.ok(Math.abs(f.a - 0.2) < 1e-6 && Math.abs(f.b - 0.5) < 1e-6 && Math.abs(f.c - 0.1) < 1e-6, JSON.stringify(f));
  const flat = fitGrowth(t, t.map(() => 3), t.map(() => 1));
  assert.ok(flat.a >= 0 && flat.b >= 0 && flat.c >= 0);
  assert.ok(Math.abs(flat.a - 3) < 1e-6);
  const noisy = fitGrowth(t, [5, 4, 4.5, 6, 7, 9, 12, 20], t.map(() => 10));
  assert.ok(noisy.a >= 0 && noisy.b >= 0 && noisy.c >= 0);
});
test('gap bins cover 0.25..14 d and nothing outside', () => {
  assert.equal(gapBinOf(0.25), 0);
  assert.equal(gapBinOf(13.99), 7);
  assert.equal(gapBinOf(14), 7);
  assert.equal(gapBinOf(0.2), -1);
  assert.equal(gapBinOf(14.5), -1);
});
test('class keys and fallbacks', () => {
  assert.equal(classKey('LEO', 'unknown', 450, 6e-4), 'LEO/unknown/p400-600/b2');
  assert.equal(classKey('LEO', 'debris', 450), 'LEO/debris/p400-600');
  assert.equal(classKey('GEO', 'rocket_body', 35786, 1), 'GEO/rocket_body');
  assert.equal(classKey('XYZ', 'unknown', 0), 'OTHER/unknown');
  assert.deepEqual(fallbackKeys('LEO/unknown/p400-600/b2'), ['LEO/unknown/p400-600', 'LEO/unknown', 'LEO/p400-600', 'LEO', 'ALL']);
  assert.deepEqual(fallbackKeys('GEO/debris'), ['GEO', 'ALL']);
  assert.equal(bstarBand(-2e-3), 'b3');
});
