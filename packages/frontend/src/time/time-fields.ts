/**
 * The clock fields the gamepad time-scrub steps through (D-pad ◄► picks one,
 * ▲▼ steps it). Pure + dependency-free so the calendar arithmetic is testable
 * without the engine or the store.
 */

export type TimeField = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

/** Beyond this gap (ms) between the sim clock and the wall clock, you're
 *  "displaced" — REVIEW styling, the ↺ return-to-present control exists, and the
 *  gamepad D-pad can park focus on it. One constant for both the cockpit HUD
 *  (renders it) and the gamepad controller (drives D-pad focus onto it), so
 *  the two can't disagree. */
export const LIVE_EPSILON_MS = 2_000;

/** Coarse → fine, which is the order D-pad ► walks. */
export const TIME_FIELD_ORDER: TimeField[] = ['year', 'month', 'day', 'hour', 'minute', 'second'];

/** Step the active field selection by `delta`, wrapping at both ends. */
export function cycleTimeField(field: TimeField, delta: number): TimeField {
  const i = TIME_FIELD_ORDER.indexOf(field);
  return TIME_FIELD_ORDER[(i + delta + TIME_FIELD_ORDER.length) % TIME_FIELD_ORDER.length];
}

/**
 * Step one whole unit of `field` on a UTC calendar, leaving every smaller field
 * untouched.
 *
 * WHY THE DATE SETTERS, not a fixed millisecond span: "+1 month" is 28–31 days and
 * "+1 year" is 365 or 366. Adding an average span (the obvious 30-day / 365.25-day
 * constants) drags the day-of-month, hour and minute along with it — so pressing ▲
 * on MONTH visibly spins the fields below it instead of incrementing the month.
 *
 * JS setter overflow is intentional and matches every date picker: Jan 31 + 1 month
 * → Mar 3 (Feb has no 31st), and 23:00 + 1 hour rolls the day.
 */
export function stepUtcField(ms: number, field: TimeField, dir: number): number {
  const d = new Date(ms);
  switch (field) {
    case 'year': d.setUTCFullYear(d.getUTCFullYear() + dir); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() + dir); break;
    case 'day': d.setUTCDate(d.getUTCDate() + dir); break;
    case 'hour': d.setUTCHours(d.getUTCHours() + dir); break;
    case 'minute': d.setUTCMinutes(d.getUTCMinutes() + dir); break;
    case 'second': d.setUTCSeconds(d.getUTCSeconds() + dir); break;
  }
  return d.getTime();
}
