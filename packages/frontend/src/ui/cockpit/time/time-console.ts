/**
 * Time console helpers: digit formatting, the "FROM NOW" delta, and the wheel's
 * per-pixel stepping. Pure (no React, no store), tested in time-console.test.ts.
 */
import { stepUtcField, type TimeField } from '../../../time/time-fields';
import { pad } from '../format';

/** Signed distance from the live edge, e.g. "−3D 04:12" / "+18:42:07". */
export function formatTimeDelta(simMs: number, wallMs: number): string {
  const diff = simMs - wallMs;
  const sign = diff < 0 ? '−' : '+';
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  return days > 0 ? `${sign}${days}D ${pad(h)}:${pad(m)}` : `${sign}${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** The six UTC digit groups of a time, zero-padded. */
export function utcFieldValues(ms: number): Record<TimeField, string> {
  const d = new Date(ms);
  return {
    year: pad(d.getUTCFullYear(), 4),
    month: pad(d.getUTCMonth() + 1),
    day: pad(d.getUTCDate()),
    hour: pad(d.getUTCHours()),
    minute: pad(d.getUTCMinutes()),
    second: pad(d.getUTCSeconds()),
  };
}

export const FIELD_LABEL: Record<TimeField, string> = {
  year: 'YEAR', month: 'MON', day: 'DAY', hour: 'HR', minute: 'MIN', second: 'SEC',
};

// ── Momentum wheel numbers (tuned in the spike by feel; kept so the dial behaves the same) ──
/** Pixels between ticks: close enough to read as a dial, far enough to see each one. */
export const TICK_SPACING = 10;
/** Every Nth tick is taller and brighter. */
export const TICK_MAJOR_EVERY = 5;
/** The strip repeats every major tick, so wrapping the offset by this is seamless. */
export const TICK_PERIOD = TICK_SPACING * TICK_MAJOR_EVERY; // 50
/** Enough ticks to cover the widest console plus one period of wrap slack. */
export const TICK_COUNT = 35;
/** Release-velocity smoothing: share of the old speed kept, and of the newest sample taken. */
export const VELOCITY_KEEP = 0.7;
export const VELOCITY_NEW = 0.3;
/** Release speed above this (px/ms) coasts; below it the drop just commits. */
export const FLICK_THRESHOLD = 0.05;
/** Velocity multiplier per 16 ms while coasting: ~1 s of glide from a hard flick. */
export const FRICTION = 0.94;
/** Coasting stops below this speed (px/ms), so it ends instead of crawling forever. */
export const STOP_VELOCITY = 0.008;
/** One scroll-wheel notch, px: about a tick and a half of dial travel. */
export const WHEEL_NOTCH_PX = 30;
/** Pixels of drag for one full turn of the field's scale (a hand-width of travel). */
export const PX_PER_ROT = 240;
/** Units of the field covered by one full turn. */
export const WHEEL_SCALE: Record<TimeField, number> = { year: 100, month: 12, day: 30, hour: 24, minute: 60, second: 60 };

/**
 * Move `ms` by a fractional number of `field` units on a UTC calendar. The whole
 * part goes through stepUtcField (so a month is 28–31 days and a year 365/366,
 * never an average); the fraction is a share of the real length of the next unit.
 */
export function advanceUtcField(ms: number, field: TimeField, units: number): number {
  const whole = Math.trunc(units);
  const frac = units - whole;
  let t = whole === 0 ? ms : stepUtcField(ms, field, whole);
  if (frac !== 0) {
    const dir = frac > 0 ? 1 : -1;
    const stepped = stepUtcField(t, field, dir);
    t += Math.abs(frac) * (stepped - t);
  }
  return Math.round(t);
}

/** Time after dragging the wheel `dxPx` right (right = later) from `ms`. */
export function wheelAdvance(ms: number, field: TimeField, dxPx: number): number {
  return advanceUtcField(ms, field, (dxPx * WHEEL_SCALE[field]) / PX_PER_ROT);
}

/** Tick strip x-offset for an accumulated drag, wrapped into one tick period. */
export function tickStripOffset(accPx: number): number {
  return ((accPx % TICK_PERIOD) + TICK_PERIOD) % TICK_PERIOD;
}
