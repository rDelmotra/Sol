/**
 * History replay navigation helpers: date-picker bounds, jump targets, the events
 * timeline window + bucket choice, and the accuracy badge text. Pure (no React,
 * no store), tested in replay-nav.test.ts.
 */
import type { HistoryAccuracy, HistoryRange, TimelineGranularity } from '../../../data/replay-types';

const DAY_MS = 86_400_000;
/** Same reach as the engine's rule (engine/controllers/timeline-target.ts LIVE_REACH_DAYS). */
export const REPLAY_RULE_DAYS = 30;
/** Live forward horizon shown in the picker (FUTURE_HORIZON_DAYS). */
export const PICKER_FUTURE_DAYS = 14;

export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/**
 * Bounds of the date picker. With the archive: its first day .. the live horizon.
 * Without it (503): the live range only (the reach of today's element sets ..
 * the forward horizon) — no error, just a narrower picker.
 */
export function pickerBounds(range: HistoryRange | null, wallMs: number): { min: string; max: string; archive: boolean } {
  const max = isoDay(wallMs + PICKER_FUTURE_DAYS * DAY_MS);
  if (!range) return { min: isoDay(wallMs - REPLAY_RULE_DAYS * DAY_MS), max, archive: false };
  return { min: range.firstDay, max, archive: true };
}

/** Jump to `day`, keeping the current UTC time of day. */
export function jumpToDayMs(day: string, simMs: number): number {
  const tod = ((simMs % DAY_MS) + DAY_MS) % DAY_MS;
  return dayStartMs(day) + tod;
}

/** Year-scrubber target: the same month/day in `year` (Feb 29 → Feb 28), clamped into [min, max]. */
export function yearJumpDay(year: number, simDay: string, min: string, max: string): string {
  const mm = simDay.slice(5, 7);
  let dd = simDay.slice(8, 10);
  if (mm === '02' && dd === '29') dd = '28';
  const d = `${String(year).padStart(4, '0')}-${mm}-${dd}`;
  return d < min ? min : d > max ? max : d;
}

/** Bucket by the span shown: > 3 years → year, > ~3 months → month, else day. */
export function chooseBucket(fromDay: string, toDay: string): TimelineGranularity {
  const spanDays = (dayStartMs(toDay) - dayStartMs(fromDay)) / DAY_MS + 1;
  if (spanDays > 3 * 366) return 'year';
  if (spanDays > 92) return 'month';
  return 'day';
}

export type TimelineZoom = 'all' | 'year' | 'month';
export const TIMELINE_ZOOMS: readonly TimelineZoom[] = ['all', 'year', 'month'];

/** The window the strip shows for a zoom around the sim day, clipped to the archive. */
export function timelineWindow(
  zoom: TimelineZoom,
  simDay: string,
  range: HistoryRange,
): { from: string; to: string; bucket: TimelineGranularity } {
  let from = range.firstDay;
  let to = range.lastDay;
  if (zoom === 'year') {
    from = `${simDay.slice(0, 4)}-01-01`;
    to = `${simDay.slice(0, 4)}-12-31`;
  } else if (zoom === 'month') {
    const y = Number(simDay.slice(0, 4));
    const m = Number(simDay.slice(5, 7));
    from = `${simDay.slice(0, 7)}-01`;
    to = isoDay(Date.UTC(y, m, 0)); // day 0 of next month = last day of this one
  }
  if (from < range.firstDay) from = range.firstDay;
  if (to > range.lastDay) to = range.lastDay;
  if (from > to) from = to; // sim day outside the archive: a one-bucket window at the edge
  return { from, to, bucket: chooseBucket(from, to) };
}

/** First UTC day of a bucket label ('YYYY', 'YYYY-MM', 'YYYY-MM-DD' or a full ISO time). */
export function bucketStartDay(t: string): string {
  if (/^\d{4}$/.test(t)) return `${t}-01-01`;
  if (/^\d{4}-\d{2}$/.test(t)) return `${t}-01`;
  return t.slice(0, 10);
}

/**
 * Every bucket start day of the window (the API leaves empty buckets out, so the
 * strip lays buckets out by time from this list, not by the returned points).
 */
export function bucketStarts(from: string, to: string, bucket: TimelineGranularity): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  let d = dayStartMs(from);
  for (let guard = 0; guard < 40_000; guard++) {
    const day = bucket === 'year' ? `${String(y).padStart(4, '0')}-01-01` : bucket === 'month' ? `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01` : isoDay(d);
    if (day > to) break;
    out.push(day);
    if (bucket === 'year') y++;
    else if (bucket === 'month') {
      m++;
      if (m > 12) { m = 1; y++; }
    } else d += DAY_MS;
  }
  return out;
}

/** Does the bucket starting `t` contain `day`? */
export function bucketContains(t: string, bucket: TimelineGranularity, day: string): boolean {
  const start = bucketStartDay(t);
  if (bucket === 'year') return day.slice(0, 4) === start.slice(0, 4);
  if (bucket === 'month') return day.slice(0, 7) === start.slice(0, 7);
  return day === start;
}

/** Lane height of a count: log-scaled against the lane's max so one breakup does not flatten everything else. */
export function laneFraction(n: number, max: number): number {
  if (!(n > 0) || !(max > 0)) return 0;
  return Math.log1p(n) / Math.log1p(max);
}

/** "±~79 km" — two significant digits, a rough figure, stated as such. */
export function formatAccuracyKm(km: number): string {
  if (!Number.isFinite(km) || km <= 0) return '—';
  const p = Math.pow(10, Math.floor(Math.log10(km)) - 1);
  const v = km >= 10 ? Math.round(km / p) * p : Number(km.toFixed(1));
  return `±~${v.toLocaleString('en-US')} km`;
}

/** Badge lines for a loaded replay day (null outside replay → no badge in live mode). */
export function accuracyBadge(
  replayDay: string | null,
  accuracy: HistoryAccuracy | null,
  sgpCount: number,
): { title: string; accuracy: string; note: string | null } | null {
  if (!replayDay) return null;
  return {
    title: `ARCHIVE CATALOG · ${replayDay}`,
    accuracy: accuracy ? `POSITIONS ${formatAccuracyKm(accuracy.medianKm)} (MEDIAN)` : 'POSITIONS · SGP4 ELEMENT SETS (ERA ERROR NOT MEASURED)',
    note: sgpCount > 0 ? `${sgpCount.toLocaleString('en-US')} OBJ ON ORIGINAL SGP MODEL (PRE-SGP4 ELEMENTS)` : null,
  };
}
