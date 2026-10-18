import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anyDsoActiveAt } from './dso-window';

const win = { validFrom: '2026-04-03T00:00:00.000Z', validTo: '2026-04-10T00:00:00.000Z' };
const at = (iso: string) => Date.parse(iso);

describe('anyDsoActiveAt', () => {
  it('is false with no snapshots', () => assert.equal(anyDsoActiveAt({}, at('2026-04-05T00:00:00Z')), false));
  it('is true inside the window', () => assert.equal(anyDsoActiveAt({ a: win }, at('2026-04-05T00:00:00Z')), true));
  it('is false well before and well after', () => {
    assert.equal(anyDsoActiveAt({ a: win }, at('2026-04-01T00:00:00Z')), false);
    assert.equal(anyDsoActiveAt({ a: win }, at('2026-10-18T00:00:00Z')), false);
  });
  it('allows the worker grace after the end', () =>
    assert.equal(anyDsoActiveAt({ a: win }, at('2026-04-10T00:05:00Z')), true));
  it('is true when any one of several windows covers the time', () =>
    assert.equal(anyDsoActiveAt({ a: win, b: { validFrom: '2026-01-01T00:00:00Z', validTo: '2026-12-31T00:00:00Z' } }, at('2026-10-18T00:00:00Z')), true));
  it('ignores unparseable dates', () =>
    assert.equal(anyDsoActiveAt({ a: { validFrom: 'x', validTo: 'y' } }, at('2026-04-05T00:00:00Z')), false));
});
