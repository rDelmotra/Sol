import path from 'path';
import { cacheDir } from '../utils/paths.js';
import { CRON_MIN_AGE_MS } from './file-cache.js';
import { readStateFile, writeStateFile } from './state-file.js';

// ============================================================
// Space-Track attempt log
//
// Space-Track asks API users to be gentle: about one GP query an hour for the
// same class, and a login per attempt. The TLE cache file only records
// SUCCESSFUL fetches, so before this log existed a failed attempt left no trace:
// with no cache and both Space-Track and CelesTrak down, every container restart
// (or crash loop) logged in to Space-Track again.
//
// This file keeps one tiny JSON record next to the cache:
//   <CACHE_DIR>/spacetrack-attempts.json
//   { lastAttemptAt, lastOutcome, consecutiveFailures,
//     attemptDay?, attemptsToday?, successToday?, alertSentDay? }
// The last four are the daily cap and the alert memory. An old file without
// them reads as "0 attempts today, no alert sent".
//
// Rules (pure, see evaluateGate), checked in this order:
//   - never attempted / missing / corrupt file -> allowed
//   - DAILY CAP: at most DAILY_ATTEMPT_CAP (5) Space-Track logins per UTC day.
//     Every attempt that starts counts, success or failure, from boot, the cron
//     or the retry timer. At the cap the gate says 'daily-cap' and retryAt is the
//     next 00:00 UTC. On a new UTC day the count starts again, so the cap can never
//     block the 02:00 UTC cron. A capped day also never leaves a backoff behind
//     that reaches into the next day: the first attempt after midnight is allowed.
//   - after a success: wait SUCCESS_MIN_GAP_MS (1 h, same constant as the cron's
//     "cache under 1 hour old" guard, so the two rules agree)
//   - after failures: wait 15 min, 30 min, 1 h, 2 h, 4 h, then 6 h (the cap)
//   A success resets the failure counter (not the daily count). The backoff cap
//   (6 h) is far below the daily cron interval, so it cannot block a whole day.
//
// When the day's 5th attempt fails and none succeeded, the update cycle sends one
// alert (src/utils/alert.ts). `alertSentDay` remembers it, so a restart or the next
// cycle on the same day does not repeat it.
//
// An attempt is written BEFORE the login as a pending failure ('started'). If the
// process dies mid-fetch (out of memory, kill), the restart still sees a failed
// attempt instead of an empty log.
//
// Nothing here can stop boot: every file error is logged at WARN and the
// function returns as if the log were empty. The file is written through a
// temp file and an atomic rename. No other file is ever touched or deleted.
// ============================================================

export type AttemptOutcome = 'success' | 'failure' | 'started';

export interface AttemptState {
  /** ISO timestamp of the last attempt (start for 'started', end otherwise). */
  lastAttemptAt: string;
  lastOutcome: AttemptOutcome;
  /** Failures in a row, including a 'started' attempt that never finished. */
  consecutiveFailures: number;
  /** UTC day ('YYYY-MM-DD') that `attemptsToday` counts. Absent in old files. */
  attemptDay?: string;
  /** Logins started on `attemptDay`. Absent means 0. */
  attemptsToday?: number;
  /** True when one of the `attemptDay` attempts succeeded. */
  successToday?: boolean;
  /** UTC day for which the "all attempts failed" alert was already sent. */
  alertSentDay?: string;
}

/** Minimum gap after a success. Same value as the cron freshness guard on purpose. */
export const SUCCESS_MIN_GAP_MS = CRON_MIN_AGE_MS; // 1 hour
export const FAILURE_BACKOFF_BASE_MS = 15 * 60_000; // 15 minutes
export const FAILURE_BACKOFF_CAP_MS = 6 * 60 * 60_000; // 6 hours
/** Space-Track logins allowed per UTC day. */
export const DAILY_ATTEMPT_CAP = 5;

const DAY_MS = 24 * 60 * 60_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** UTC calendar day of a timestamp, 'YYYY-MM-DD'. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The next 00:00 UTC strictly after `ms`. */
export function nextUtcMidnight(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS;
}

/** Attempts already made on the UTC day of `now`. A stamp from another day (old, or skewed into the future) counts as 0. */
export function attemptsOnDay(state: AttemptState | null, now: number): number {
  if (!state || state.attemptDay !== utcDay(now)) return 0;
  return state.attemptsToday ?? 0;
}

// ------------------------------------------------------------
// Pure policy (injectable clock: every function takes `now`)
// ------------------------------------------------------------

/** Wait after N consecutive failures: 15 min, 30 min, 1 h, 2 h, 4 h, then 6 h. */
export function failureBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  const exponent = Math.min(n - 1, 16);
  return Math.min(FAILURE_BACKOFF_CAP_MS, FAILURE_BACKOFF_BASE_MS * 2 ** exponent);
}

export type GateDecision =
  | { allowed: true }
  | {
      allowed: false;
      retryAt: number;
      reason: 'recent-success' | 'backoff' | 'daily-cap';
      consecutiveFailures: number;
    };

/**
 * May a Space-Track login happen now?
 *
 * A stamp in the future (clock skew, a hand-edited file) is treated as "now", so
 * a bad file can delay the next attempt by at most one gap, never indefinitely.
 * The same goes for the daily count: it only counts when its day is today, so a
 * future or old day never blocks anything.
 */
export function evaluateGate(state: AttemptState | null, now: number): GateDecision {
  if (!state) return { allowed: true };

  if (attemptsOnDay(state, now) >= DAILY_ATTEMPT_CAP) {
    return {
      allowed: false,
      retryAt: nextUtcMidnight(now),
      reason: 'daily-cap',
      consecutiveFailures: state.lastOutcome === 'success' ? 0 : Math.max(1, state.consecutiveFailures),
    };
  }

  const last = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(last)) return { allowed: true };

  // A day that ended at the cap leaves no wait behind: the first attempt after
  // midnight is allowed, so the cap can never push the 02:00 cron back.
  if (
    state.attemptDay !== undefined &&
    state.attemptDay < utcDay(now) &&
    (state.attemptsToday ?? 0) >= DAILY_ATTEMPT_CAP
  ) {
    return { allowed: true };
  }

  const anchor = Math.min(last, now);
  const succeeded = state.lastOutcome === 'success';
  const waitMs = succeeded ? SUCCESS_MIN_GAP_MS : failureBackoffMs(state.consecutiveFailures);
  const retryAt = anchor + waitMs;

  if (now >= retryAt) return { allowed: true };
  return {
    allowed: false,
    retryAt,
    reason: succeeded ? 'recent-success' : 'backoff',
    consecutiveFailures: succeeded ? 0 : Math.max(1, state.consecutiveFailures),
  };
}

/** Transition: a login/fetch is about to start. Counted as a failure until it succeeds. */
export function stateOnStart(previous: AttemptState | null, now: number): AttemptState {
  const priorFailures = previous && previous.lastOutcome !== 'success' ? previous.consecutiveFailures : 0;
  const day = utcDay(now);
  const sameDay = previous?.attemptDay === day;
  return {
    lastAttemptAt: new Date(now).toISOString(),
    lastOutcome: 'started',
    consecutiveFailures: priorFailures + 1,
    attemptDay: day,
    attemptsToday: (sameDay ? (previous?.attemptsToday ?? 0) : 0) + 1,
    ...(sameDay && previous?.successToday ? { successToday: true } : {}),
    ...(previous?.alertSentDay ? { alertSentDay: previous.alertSentDay } : {}),
  };
}

/** Transition: the attempt that began as `started` failed. The count is already in. */
export function stateOnFailure(started: AttemptState, now: number): AttemptState {
  return {
    ...started,
    lastAttemptAt: new Date(now).toISOString(),
    lastOutcome: 'failure',
    consecutiveFailures: Math.max(1, started.consecutiveFailures),
  };
}

/**
 * Transition: success resets the failure counter. The day's attempt count and the
 * alert memory come from `base` (the pending record of this attempt) and survive.
 */
export function stateOnSuccess(now: number, base: AttemptState | null = null): AttemptState {
  const carry: Partial<AttemptState> = {};
  if (base?.attemptDay !== undefined) {
    carry.attemptDay = base.attemptDay;
    carry.attemptsToday = base.attemptsToday ?? 0;
    carry.successToday = true;
  }
  if (base?.alertSentDay) carry.alertSentDay = base.alertSentDay;
  return {
    lastAttemptAt: new Date(now).toISOString(),
    lastOutcome: 'success',
    consecutiveFailures: 0,
    ...carry,
  };
}

/** True when the day's cap was used up, every attempt failed, and no alert went out yet for that day. */
export function dailyFailureAlertDue(state: AttemptState | null): boolean {
  if (!state || state.lastOutcome !== 'failure' || state.attemptDay === undefined) return false;
  return (
    (state.attemptsToday ?? 0) >= DAILY_ATTEMPT_CAP && !state.successToday && state.alertSentDay !== state.attemptDay
  );
}

/** Validate a parsed JSON value. Anything off -> null (treated as an empty log). */
export function parseAttemptState(raw: unknown): AttemptState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const { lastAttemptAt, lastOutcome, consecutiveFailures } = r;
  if (typeof lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(lastAttemptAt))) return null;
  if (lastOutcome !== 'success' && lastOutcome !== 'failure' && lastOutcome !== 'started') return null;
  if (typeof consecutiveFailures !== 'number' || !Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    return null;
  }
  const state: AttemptState = { lastAttemptAt, lastOutcome, consecutiveFailures };

  // The daily fields are optional. An old file has none; a bad value is dropped (reads as 0).
  const { attemptDay, attemptsToday, successToday, alertSentDay } = r;
  if (typeof attemptDay === 'string' && DAY_PATTERN.test(attemptDay)) {
    state.attemptDay = attemptDay;
    state.attemptsToday =
      typeof attemptsToday === 'number' && Number.isInteger(attemptsToday) && attemptsToday >= 0 ? attemptsToday : 0;
    if (successToday === true) state.successToday = true;
  }
  if (typeof alertSentDay === 'string' && DAY_PATTERN.test(alertSentDay)) state.alertSentDay = alertSentDay;
  return state;
}

// ------------------------------------------------------------
// File I/O (never throws)
// ------------------------------------------------------------

export function attemptLogPath(): string {
  return path.join(cacheDir(), 'spacetrack-attempts.json');
}

/** Read the log. Missing -> null silently. Unreadable or corrupt -> null with one WARN. */
export function readAttemptState(): AttemptState | null {
  return readStateFile(attemptLogPath(), 'Space-Track attempt log', parseAttemptState);
}

/** Atomic write: temp file in the same directory, then rename. Failure -> WARN, boot goes on. */
export function writeAttemptState(state: AttemptState): void {
  writeStateFile(attemptLogPath(), 'Space-Track attempt log', state);
}

// ------------------------------------------------------------
// Convenience wrappers used by the update cycle
// ------------------------------------------------------------

export interface SpaceTrackAttempt {
  /** The pending record written before the login; hand it back to fail/succeed. */
  started: AttemptState;
}

/** Read the log and decide. */
export function checkSpaceTrackGate(now: number): GateDecision {
  return evaluateGate(readAttemptState(), now);
}

/** Persist a pending attempt BEFORE contacting Space-Track. */
export function beginSpaceTrackAttempt(now: number): SpaceTrackAttempt {
  const started = stateOnStart(readAttemptState(), now);
  writeAttemptState(started);
  return { started };
}

/** Settle a failed attempt. Returns the record that was written (also when the write failed). */
export function recordSpaceTrackFailure(attempt: SpaceTrackAttempt, now: number): AttemptState {
  const state = stateOnFailure(attempt.started, now);
  writeAttemptState(state);
  return state;
}

/** Settle a successful attempt. Without `attempt` the day's counts are taken from the file. */
export function recordSpaceTrackSuccess(now: number, attempt?: SpaceTrackAttempt): void {
  writeAttemptState(stateOnSuccess(now, attempt ? attempt.started : readAttemptState()));
}

/** Remember that the alert for this record's day went out, so a restart does not repeat it. */
export function markDailyAlertSent(state: AttemptState): void {
  if (state.attemptDay === undefined) return;
  writeAttemptState({ ...state, alertSentDay: state.attemptDay });
}

/** One INFO line for a skipped attempt: says when the next one is allowed. */
export function describeSkippedAttempt(decision: Extract<GateDecision, { allowed: false }>, now: number): string {
  const waitMin = Math.max(1, Math.ceil((decision.retryAt - now) / 60_000));
  const why =
    decision.reason === 'recent-success'
      ? 'last Space-Track fetch succeeded less than 1 hour ago'
      : decision.reason === 'daily-cap'
        ? `daily limit of ${DAILY_ATTEMPT_CAP} Space-Track attempts reached for this UTC day`
        : `backing off after ${decision.consecutiveFailures} failed attempt${decision.consecutiveFailures === 1 ? '' : 's'} in a row`;
  return (
    `Space-Track attempt skipped (${why}); will retry after ${new Date(decision.retryAt).toISOString()} ` +
    `(in about ${waitMin} min) — using the stale cache / CelesTrak meanwhile`
  );
}
