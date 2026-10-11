import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cycleTimeField, stepUtcField, TIME_FIELD_ORDER } from './time-fields';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe('time-fields: cycleTimeField', () => {
  it('walks coarse → fine and wraps at both ends', () => {
    assert.equal(cycleTimeField('year', 1), 'month');
    assert.equal(cycleTimeField('minute', 1), 'second');
    assert.equal(cycleTimeField('second', 1), 'year');
    assert.equal(cycleTimeField('year', -1), 'second');
    assert.equal(cycleTimeField('day', -1), 'month');
  });

  it('a full lap over the field count returns to the start', () => {
    let f = TIME_FIELD_ORDER[0];
    for (let i = 0; i < TIME_FIELD_ORDER.length; i++) f = cycleTimeField(f, 1);
    assert.equal(f, TIME_FIELD_ORDER[0]);
  });
});

describe('time-fields: stepUtcField', () => {
  // The core contract: stepping a field moves THAT field by one and leaves every
  // smaller field alone. The old fixed-millisecond version failed exactly here.
  it('steps the active field by one and leaves smaller fields untouched', () => {
    const t = at('2026-03-15T09:41:33.250Z');
    assert.equal(iso(stepUtcField(t, 'year', 1)), '2027-03-15T09:41:33.250Z');
    assert.equal(iso(stepUtcField(t, 'month', 1)), '2026-04-15T09:41:33.250Z');
    assert.equal(iso(stepUtcField(t, 'day', 1)), '2026-03-16T09:41:33.250Z');
    assert.equal(iso(stepUtcField(t, 'hour', 1)), '2026-03-15T10:41:33.250Z');
    assert.equal(iso(stepUtcField(t, 'minute', 1)), '2026-03-15T09:42:33.250Z');
    // Seconds are the finest field: only the second moves, sub-second ms survive.
    assert.equal(iso(stepUtcField(t, 'second', 1)), '2026-03-15T09:41:34.250Z');
  });

  it('steps backward symmetrically', () => {
    const t = at('2026-03-15T09:41:33.250Z');
    assert.equal(iso(stepUtcField(t, 'month', -1)), '2026-02-15T09:41:33.250Z');
    assert.equal(iso(stepUtcField(t, 'day', -1)), '2026-03-14T09:41:33.250Z');
    assert.equal(iso(stepUtcField(t, 'year', -1)), '2025-03-15T09:41:33.250Z');
  });

  it('a month step is a real calendar month, not a 30-day average', () => {
    // Feb 2026 has 28 days; a +30d constant would land on Mar 3 and change the day.
    assert.equal(iso(stepUtcField(at('2026-02-10T00:00:00.000Z'), 'month', 1)), '2026-03-10T00:00:00.000Z');
    // Jan has 31; a +30d constant would land on Jan 31, not Feb 1.
    assert.equal(iso(stepUtcField(at('2026-01-01T00:00:00.000Z'), 'month', 1)), '2026-02-01T00:00:00.000Z');
  });

  it('a year step crosses a leap year without dragging the date', () => {
    // 2024 is a leap year; a +365.25d constant would land 6 h off and shift the hour.
    assert.equal(iso(stepUtcField(at('2023-06-01T12:00:00.000Z'), 'year', 1)), '2024-06-01T12:00:00.000Z');
    assert.equal(iso(stepUtcField(at('2024-06-01T12:00:00.000Z'), 'year', 1)), '2025-06-01T12:00:00.000Z');
  });

  it('rolls over at unit boundaries', () => {
    assert.equal(iso(stepUtcField(at('2026-12-31T23:59:59.000Z'), 'second', 1)), '2027-01-01T00:00:00.000Z');
    assert.equal(iso(stepUtcField(at('2026-01-01T00:00:00.000Z'), 'second', -1)), '2025-12-31T23:59:59.000Z');
    assert.equal(iso(stepUtcField(at('2026-12-31T23:59:00.000Z'), 'minute', 1)), '2027-01-01T00:00:00.000Z');
    assert.equal(iso(stepUtcField(at('2026-01-01T00:00:00.000Z'), 'day', -1)), '2025-12-31T00:00:00.000Z');
    assert.equal(iso(stepUtcField(at('2026-12-01T00:00:00.000Z'), 'month', 1)), '2027-01-01T00:00:00.000Z');
  });

  it('lands on Feb 29 only in a leap year (documented setter overflow)', () => {
    // Jan 31 + 1 month has no Feb 31 to land on, so it overflows into March.
    assert.equal(iso(stepUtcField(at('2026-01-31T00:00:00.000Z'), 'month', 1)), '2026-03-03T00:00:00.000Z');
    // 2024 is a leap year, so the same step lands on Feb 29 rather than overflowing.
    assert.equal(iso(stepUtcField(at('2024-01-29T00:00:00.000Z'), 'month', 1)), '2024-02-29T00:00:00.000Z');
  });

  it('N single steps equal one N-sized move (auto-repeat cannot drift)', () => {
    let t = at('2026-03-15T09:41:00.000Z');
    for (let i = 0; i < 24; i++) t = stepUtcField(t, 'hour', 1);
    assert.equal(iso(t), '2026-03-16T09:41:00.000Z');
  });
});
