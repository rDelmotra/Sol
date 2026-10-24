import test from 'node:test';
import assert from 'node:assert/strict';
import { evalLaw, interpLog, resolveClass, sigmaRIC, type UncertaintyModel } from './uncertainty-model.js';

const law = (a: number, b: number, c: number) => ({ a, b, c });
const M: UncertaintyModel = {
  version: 1,
  classes: {
    ALL: { n: 1, growth: { R: law(0.1, 0.1, 0), I: law(0.2, 1, 0.1), C: law(0.05, 0.05, 0) } },
    LEO: { n: 1, growth: { R: law(0.2, 0.2, 0), I: law(0.5, 2, 0.2), C: law(0.1, 0.1, 0) } },
    'LEO/unknown/p400-600': { n: 1, growth: { R: law(1, 0, 0), I: law(2, 0, 0), C: law(3, 0, 0) } },
  },
  tail: { LEO: 1.5, ALL: 1 },
  tailCold: { LEO: 2, ALL: 2 },
  conservative: { LEO: 2, ALL: 2 },
  objectScale: { '7': [2, 3, 4], '8': 0.5 },
};

test('class level, regime tail, exact class and fallbacks', () => {
  assert.equal(resolveClass(M, 'LEO/unknown/p400-600/b2'), 'LEO/unknown/p400-600');
  assert.equal(resolveClass(M, 'LEO/debris/p>=800'), 'LEO');
  assert.equal(resolveClass(M, 'MEO/unknown'), 'ALL');
  // string class = no object scale -> the cold factor (2) applies
  assert.deepEqual(sigmaRIC('LEO/unknown/p400-600/b2', 3, M), [2, 4, 6]);
  assert.deepEqual(sigmaRIC('MEO/unknown', 1, M).map((x) => +x.toFixed(9)), [0.4, 2.6, 0.2]);
});
test('object with its own scale uses the warm tail and per-axis scale; scalar scale works too', () => {
  const s = sigmaRIC({ noradId: 7, regime: 'LEO', objectType: 'unknown', perigee: 500 }, 3, M);
  assert.deepEqual(s, [1 * 1.5 * 2, 2 * 1.5 * 3, 3 * 1.5 * 4]);
  assert.deepEqual(sigmaRIC({ noradId: 8, regime: 'LEO', objectType: 'unknown', perigee: 500 }, 3, M), [0.75, 1.5, 2.25]);
  // unknown id: no scale -> cold
  assert.deepEqual(sigmaRIC({ noradId: 999, regime: 'LEO', objectType: 'unknown', perigee: 500 }, 3, M), [2, 4, 6]);
});
test('conservative multiplies; negative age is the same as positive', () => {
  const a = sigmaRIC({ noradId: 7, regime: 'LEO', objectType: 'unknown', perigee: 500 }, 3, M);
  const b = sigmaRIC({ noradId: 7, regime: 'LEO', objectType: 'unknown', perigee: 500 }, -3, M, true);
  assert.deepEqual(b, a.map((x) => x * 2));
});
test('below 0.25 d the value at 0.25 d is used; beyond 14 d it continues linearly', () => {
  assert.equal(evalLaw(law(0, 4, 0), 0), 1);
  assert.equal(evalLaw(law(0, 4, 0), 0.25), 1);
  const l = law(1, 1, 1);
  const at14 = 1 + 14 + 196, slope = 1 + 28;
  assert.ok(Math.abs(evalLaw(l, 16) - (at14 + 2 * slope)) < 1e-9);
  assert.ok(evalLaw(l, 16) < 1 + 16 + 256); // less than the quadratic would give
});
test('log interpolation', () => {
  assert.equal(interpLog([1, 4], [10, 20], 0.5), 10);
  assert.equal(interpLog([1, 4], [10, 20], 9), 20);
  assert.ok(Math.abs(interpLog([1, 4], [10, 20], 2) - 15) < 1e-9);
});
