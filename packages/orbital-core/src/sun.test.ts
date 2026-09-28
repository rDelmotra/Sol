import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sunDirection } from './sun.js';

describe('sun: sunDirection', () => {
  it('returns a unit vector at a range of instants', () => {
    for (const iso of ['1970-01-01T00:00:00Z', '2000-01-01T12:00:00Z', '2026-03-20T09:00:00Z', '2026-09-23T00:00:00Z']) {
      const s = sunDirection(Date.parse(iso));
      const mag = Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
      assert.ok(Math.abs(mag - 1) < 1e-9, `|sunDirection(${iso})| = ${mag}`);
    }
  });

  it('is near (1,0,0) at the March 2026 equinox instant', () => {
    const equinoxMs = Date.parse('2026-03-20T09:00:00Z');
    const s = sunDirection(equinoxMs);
    assert.ok(Math.abs(s.x - 1) < 0.01, `sun.x should be near 1, got ${s.x}`);
    assert.ok(Math.abs(s.y) < 0.01, `sun.y should be near 0, got ${s.y}`);
    assert.ok(Math.abs(s.z) < 0.01, `sun.z should be near 0, got ${s.z}`);
  });
});
