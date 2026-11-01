import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCountdown,
  formatEncounterManoeuvre,
  formatManoeuvredAgo,
  formatMiss,
  formatObjectLabel,
  formatPc,
  formatRelSpeed,
  formatServerApproach,
  formatTcaClock,
  formatUtcClock,
} from './encounter-format';

const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const at = (s: number) => T0 + s * 1000;

describe('formatMiss', () => {
  it('uses metres under 1 km and kilometres above', () => {
    assert.equal(formatMiss(0.412), '412 m');
    assert.equal(formatMiss(0.0004), '0 m');
    assert.equal(formatMiss(1), '1.00 km');
    assert.equal(formatMiss(3.456), '3.46 km');
    assert.equal(formatMiss(42.37), '42.4 km');
    assert.equal(formatMiss(1234.4), '1,234 km');
  });
  it('never prints 1000 m', () => {
    assert.equal(formatMiss(0.9996), '1.00 km');
  });
  it('dashes for missing numbers', () => {
    assert.equal(formatMiss(null), '—');
    assert.equal(formatMiss(Number.NaN), '—');
  });
});

describe('formatPc / formatRelSpeed', () => {
  it('prints scientific notation with one decimal', () => {
    assert.equal(formatPc(2.34e-5), '2.3e-5');
    assert.equal(formatPc(1e-9), '1.0e-9');
    assert.equal(formatPc(0.0123), '1.2e-2');
  });
  it('dashes for null, prints zero plainly', () => {
    assert.equal(formatPc(null), '—');
    assert.equal(formatPc(0), '0');
  });
  it('relative speed has two decimals', () => {
    assert.equal(formatRelSpeed(7.456), '7.46 km/s');
    assert.equal(formatRelSpeed(null), '—');
  });
});

describe('formatCountdown', () => {
  it('hours and minutes when more than an hour away', () => {
    assert.equal(formatCountdown(at(3 * 3600 + 12 * 60 + 5), T0), 'in 3 h 12 m');
  });
  it('days and hours from 24 h', () => {
    assert.equal(formatCountdown(at(28 * 3600), T0), 'in 1 d 4 h');
  });
  it('T-hh:mm:ss under an hour', () => {
    assert.equal(formatCountdown(at(105), T0), 'T−00:01:45');
    assert.equal(formatCountdown(at(59 * 60 + 59), T0), 'T−00:59:59');
  });
  it('passed once TCA is behind the clock', () => {
    assert.equal(formatCountdown(at(-1), T0), 'passed');
    assert.equal(formatCountdown(at(0), T0), 'T−00:00:00');
  });
});

describe('formatTcaClock', () => {
  it('mm:ss within the hour, h:mm:ss beyond, rounding up so zero means now', () => {
    assert.equal(formatTcaClock(at(105), T0), 'TCA in 01:45');
    assert.equal(formatTcaClock(at(0.2), T0), 'TCA in 00:01');
    assert.equal(formatTcaClock(at(3725), T0), 'TCA in 1:02:05');
  });
  it('says passed afterwards', () => {
    assert.equal(formatTcaClock(at(-3), T0), 'TCA passed');
  });
});

describe('labels', () => {
  it('UTC clock', () => {
    assert.equal(formatUtcClock('2026-11-01T14:03:22.400Z'), '14:03:22 UTC');
    assert.equal(formatUtcClock('nonsense'), '—');
  });
  it('server approach line carries the server numbers', () => {
    assert.equal(
      formatServerApproach({ tca: '2026-11-01T14:03:22Z', missKm: 0.412, pc: 2.3e-5 }),
      'Closest approach 412 m at 14:03:22 UTC · Pc 2.3e-5',
    );
    assert.equal(
      formatServerApproach({ tca: '2026-11-01T14:03:22Z', missKm: 2.5, pc: null }),
      'Closest approach 2.50 km at 14:03:22 UTC',
    );
  });
  it('object label', () => {
    assert.equal(formatObjectLabel({ noradId: 25544, name: 'ISS (ZARYA)' }), 'ISS (ZARYA) (25544)');
    assert.equal(formatObjectLabel({ noradId: 99999, name: null }), '99999');
  });
});

describe('formatManoeuvredAgo', () => {
  const ago = (s: number) => new Date(T0 - s * 1000).toISOString();
  it('counts days, hours, then says under an hour', () => {
    assert.equal(formatManoeuvredAgo(ago(2 * 86_400 + 3600), T0), 'manoeuvred 2 d ago');
    assert.equal(formatManoeuvredAgo(ago(86_400), T0), 'manoeuvred 1 d ago');
    assert.equal(formatManoeuvredAgo(ago(5 * 3600 + 59 * 60), T0), 'manoeuvred 5 h ago');
    assert.equal(formatManoeuvredAgo(ago(90), T0), 'manoeuvred < 1 h ago');
  });
  it('is null when there is no change on record, the time is bad, or the clock is before it', () => {
    assert.equal(formatManoeuvredAgo(null, T0), null);
    assert.equal(formatManoeuvredAgo(undefined, T0), null);
    assert.equal(formatManoeuvredAgo('soon', T0), null);
    assert.equal(formatManoeuvredAgo(new Date(T0 + 1000).toISOString(), T0), null);
  });
});

describe('formatEncounterManoeuvre', () => {
  const t2d = new Date(T0 - 2 * 86_400_000).toISOString();
  const t1d = new Date(T0 - 86_400_000).toISOString();
  const enc = (a: string | null, b: string | null) => ({ a: { noradId: 10, lastManoeuvreAt: a }, b: { noradId: 20, lastManoeuvreAt: b } });
  it('names the other object implicitly and the focused one explicitly', () => {
    assert.equal(formatEncounterManoeuvre(enc(null, t2d), 10, T0), 'manoeuvred 2 d ago');
    assert.equal(formatEncounterManoeuvre(enc(null, t2d), 20, T0), 'this object manoeuvred 2 d ago');
    assert.equal(formatEncounterManoeuvre(enc(t1d, t2d), 10, T0), 'this object manoeuvred 1 d ago · other manoeuvred 2 d ago');
  });
  it('is null without a change on record', () => {
    assert.equal(formatEncounterManoeuvre(enc(null, null), 10, T0), null);
  });
});
