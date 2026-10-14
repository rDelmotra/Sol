import type { DsoRegistryEntry } from '../registry/index.js';

export interface HorizonsCoverageBounds {
  earliestAvailable: Date | null;
  latestAvailable: Date | null;
}

export interface HorizonsRequestWindow {
  windowStart: Date;
  windowEnd: Date;
}

const COVERAGE_LOWER_BOUND_REGEX =
  /prior to\s+(A\.D\.\s+\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*TDB/i;
const COVERAGE_UPPER_BOUND_REGEX =
  /after\s+(A\.D\.\s+\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*TDB/i;

function parseCalendarDateTdbToDate(calendarDateRaw: string): Date {
  const match = calendarDateRaw.match(
    /^A\.D\.\s+(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/,
  );
  if (!match) {
    throw new Error(`Unexpected Horizons calendar date format: ${calendarDateRaw}`);
  }

  const [, year, monthToken, day, time] = match;
  const normalizedMonthToken = `${monthToken[0].toUpperCase()}${monthToken.slice(1).toLowerCase()}`;
  const month = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12',
  }[normalizedMonthToken];

  if (!month) {
    throw new Error(`Unexpected Horizons month token: ${monthToken}`);
  }

  const parsed = new Date(`${year}-${month}-${day}T${time}Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid Horizons calendar date: ${calendarDateRaw}`);
  }

  return parsed;
}

function tryParseCoverageBound(calendarDateRaw: string): Date | null {
  try {
    return parseCalendarDateTdbToDate(calendarDateRaw);
  } catch {
    return null;
  }
}

export function extractCoverageBoundsFromError(message: string): HorizonsCoverageBounds | null {
  const lowerMatch = message.match(COVERAGE_LOWER_BOUND_REGEX);
  const upperMatch = message.match(COVERAGE_UPPER_BOUND_REGEX);

  if (!lowerMatch && !upperMatch) {
    return null;
  }

  return {
    earliestAvailable: lowerMatch ? tryParseCoverageBound(lowerMatch[1]) : null,
    latestAvailable: upperMatch ? tryParseCoverageBound(upperMatch[1]) : null,
  };
}

export function clampWindowToCoverageBounds(
  entry: DsoRegistryEntry,
  windowStart: Date,
  windowEnd: Date,
  coverageBounds: HorizonsCoverageBounds,
): HorizonsRequestWindow | null {
  const originalStartMs = windowStart.getTime();
  const originalEndMs = windowEnd.getTime();
  const marginMs = entry.sampleStepSec * 1000;

  let clampedStartMs = originalStartMs;
  let clampedEndMs = originalEndMs;

  if (coverageBounds.earliestAvailable) {
    clampedStartMs = Math.max(
      clampedStartMs,
      coverageBounds.earliestAvailable.getTime() + marginMs,
    );
  }

  if (coverageBounds.latestAvailable) {
    clampedEndMs = Math.min(
      clampedEndMs,
      coverageBounds.latestAvailable.getTime() - marginMs,
    );
  }

  if (clampedEndMs <= clampedStartMs) {
    return null;
  }

  if (clampedEndMs - clampedStartMs < marginMs) {
    return null;
  }

  if (clampedStartMs === originalStartMs && clampedEndMs === originalEndMs) {
    return null;
  }

  return {
    windowStart: new Date(clampedStartMs),
    windowEnd: new Date(clampedEndMs),
  };
}

export function deriveClampedRetryWindowFromError(
  entry: DsoRegistryEntry,
  windowStart: Date,
  windowEnd: Date,
  errorMessage: string,
): HorizonsRequestWindow | null {
  const coverageBounds = extractCoverageBoundsFromError(errorMessage);
  if (!coverageBounds || (!coverageBounds.earliestAvailable && !coverageBounds.latestAvailable)) {
    return null;
  }

  return clampWindowToCoverageBounds(entry, windowStart, windowEnd, coverageBounds);
}

// ============================================================
// Ended missions
//
// Horizons answers an out-of-range request with ONE bound per error:
//   "... prior to A.D. 2026-APR-02 ... TDB"  (the data starts later than the request)
//   "... after A.D. 2026-APR-10 ... TDB"     (the data ends earlier than the request)
// So a window that is wrong at both ends takes two clamp steps. These helpers keep
// the bounds seen so far, clamp the window to their intersection, and tell the
// caller when the data ended in the past, so a finished mission is not asked for
// again every cycle.
// ============================================================

/** Data that ended more than this long ago counts as a finished mission. */
export const EPHEMERIS_ENDED_GRACE_MS = 24 * 60 * 60 * 1000;

/** Keep the strictest bound seen so far on each side. */
export function mergeCoverageBounds(
  known: HorizonsCoverageBounds,
  found: HorizonsCoverageBounds,
): HorizonsCoverageBounds {
  const later = (a: Date | null, b: Date | null): Date | null =>
    a && b ? (a.getTime() >= b.getTime() ? a : b) : (a ?? b);
  const earlier = (a: Date | null, b: Date | null): Date | null =>
    a && b ? (a.getTime() <= b.getTime() ? a : b) : (a ?? b);
  return {
    earliestAvailable: later(known.earliestAvailable, found.earliestAvailable),
    latestAvailable: earlier(known.latestAvailable, found.latestAvailable),
  };
}

/** True when the data ends more than a day before `now`. */
export function isEphemerisEndedInPast(bounds: HorizonsCoverageBounds, now: Date): boolean {
  const latest = bounds.latestAvailable;
  return latest !== null && latest.getTime() < now.getTime() - EPHEMERIS_ENDED_GRACE_MS;
}

export type CoveragePlan =
  | { action: 'retry'; window: HorizonsRequestWindow }
  /** The data stopped before the window even starts. Nothing to retry. */
  | { action: 'ended'; endedAt: Date }
  /** The bounds cannot produce a new window (data not started yet, too short, or no change). */
  | { action: 'give-up' };

/**
 * Decide the next step after a coverage error, given every bound seen so far.
 * The window is always clamped from the ORIGINAL request, never from a clamp of a clamp.
 */
export function planCoverageRetry(
  entry: DsoRegistryEntry,
  windowStart: Date,
  windowEnd: Date,
  bounds: HorizonsCoverageBounds,
  now: Date,
): CoveragePlan {
  const marginMs = entry.sampleStepSec * 1000;
  const latest = bounds.latestAvailable;

  // Empty intersection because the data ended before the window begins. "Ended" means
  // the same thing as everywhere else: the data stopped more than the grace period ago.
  // A mission that stopped an hour ago may still get new data, so that case is left to
  // the normal (transient) failure path and its backoff.
  if (latest && latest.getTime() - marginMs <= windowStart.getTime() && isEphemerisEndedInPast(bounds, now)) {
    return { action: 'ended', endedAt: latest };
  }

  const window = clampWindowToCoverageBounds(entry, windowStart, windowEnd, bounds);
  return window ? { action: 'retry', window } : { action: 'give-up' };
}
