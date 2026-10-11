import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advanceUtcField, formatTimeDelta, tickStripOffset, utcFieldValues, wheelAdvance } from './time-console';

const T = Date.UTC(2026, 0, 31, 12, 30, 45);

describe('time console helpers', () => {
  it('formats the delta with a sign and day form', () => {
    assert.equal(formatTimeDelta(0, 3 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000), '−3D 04:12');
    assert.equal(formatTimeDelta(18 * 3_600_000 + 42 * 60_000 + 7000, 0), '+18:42:07');
  });
  it('pads the digit groups', () => {
    assert.deepEqual(utcFieldValues(Date.UTC(987, 2, 4, 5, 6, 7)), {
      year: '0987', month: '03', day: '04', hour: '05', minute: '06', second: '07',
    });
  });
  it('whole months and years are calendar steps, not average spans', () => {
    assert.equal(advanceUtcField(Date.UTC(2026, 1, 1), 'month', 1), Date.UTC(2026, 2, 1));
    assert.equal(advanceUtcField(Date.UTC(2024, 0, 1), 'year', 1), Date.UTC(2025, 0, 1));
    assert.equal(advanceUtcField(Date.UTC(2024, 0, 1), 'year', 4), Date.UTC(2028, 0, 1));
  });
  it('a fraction is a share of the real month length', () => {
    const feb = advanceUtcField(Date.UTC(2026, 1, 1), 'month', 0.5);
    assert.equal(feb, Date.UTC(2026, 1, 1) + 14 * 86_400_000);
    const back = advanceUtcField(Date.UTC(2026, 2, 1), 'month', -0.5);
    assert.equal(back, Date.UTC(2026, 2, 1) - 14 * 86_400_000);
  });
  it('sub-day fields move linearly per pixel', () => {
    assert.equal(wheelAdvance(T, 'second', 240), T + 60_000);
    assert.equal(wheelAdvance(T, 'hour', -10), T - 3_600_000);
  });
  it('year wheel lands on the same calendar day', () => {
    const t = Date.UTC(2020, 5, 15);
    assert.equal(wheelAdvance(t, 'year', 240 / 100), Date.UTC(2021, 5, 15));
  });
  it('tick strip offset wraps into 0..50', () => {
    assert.equal(tickStripOffset(-10), 40);
    assert.equal(tickStripOffset(120), 20);
  });
});
