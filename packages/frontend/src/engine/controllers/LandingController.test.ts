import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveLanding } from './LandingController';

describe('resolveLanding', () => {
  const existing = { lat: 10, lon: 20, alt: 0.3 };
  it('stands on the picked point at sea level', () => {
    assert.deepEqual(resolveLanding({ latDeg: 1, lonDeg: 2 }, existing), {
      landing: { lat: 1, lon: 2, alt: 0 }, moved: true,
    });
  });
  it('on a miss reuses the existing location unchanged', () => {
    assert.deepEqual(resolveLanding(null, existing), { landing: existing, moved: false });
  });
  it('does nothing on a miss with no location', () => {
    assert.equal(resolveLanding(null, null), null);
  });
});
