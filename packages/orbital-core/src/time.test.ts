import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JD_J2000, julianDate, gmst } from './time.js';

describe('time: julianDate', () => {
  it('matches the known Julian date at the Unix epoch', () => {
    assert.equal(julianDate(0), 2440587.5);
  });

  it('matches JD_J2000 at 2000-01-01T12:00:00Z', () => {
    const j2000Ms = Date.parse('2000-01-01T12:00:00Z');
    assert.equal(julianDate(j2000Ms), JD_J2000);
  });
});

describe('time: gmst', () => {
  it('is in [0, 2π) across a range of timestamps', () => {
    for (const iso of ['1970-01-01T00:00:00Z', '2000-01-01T12:00:00Z', '2026-01-01T00:00:00Z', '2050-06-15T12:34:56Z']) {
      const g = gmst(Date.parse(iso));
      assert.ok(g >= 0 && g < 2 * Math.PI, `gmst(${iso}) = ${g} out of [0, 2π)`);
    }
  });

  it('advances at ~360.98564736629 deg/day (finite-difference rate, no wrap)', () => {
    // t0 chosen far from the [0, 2π) wrap boundary (see astro-golden.json: gast ≈ 1.76 rad here).
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const dtMs = 1000; // small enough that gmst(t0+dtMs) cannot wrap past 2π
    const rate = (gmst(t0 + dtMs) - gmst(t0)) / dtMs; // rad/ms
    const expectedRate = (360.98564736629 * Math.PI / 180) / 86400000;
    assert.ok(Math.abs(rate - expectedRate) < 1e-12, `rate ${rate} vs expected ${expectedRate}`);
  });

  it('matches the known value at J2000.0 (~280.46061837°, in radians)', () => {
    const j2000Ms = Date.parse('2000-01-01T12:00:00Z');
    const expectedRad = 280.46061837 * (Math.PI / 180);
    assert.ok(Math.abs(gmst(j2000Ms) - expectedRad) < 1e-6);
  });
});
