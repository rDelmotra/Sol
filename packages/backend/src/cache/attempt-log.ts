import fs from 'fs';
import path from 'path';
import { cacheDir } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { CRON_MIN_AGE_MS } from './file-cache.js';

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
//   { lastAttemptAt, lastOutcome, consecutiveFailures }
//
// Rule (pure, see evaluateGate):
//   - never attempted / missing / corrupt file -> allowed
//   - after a success: wait SUCCESS_MIN_GAP_MS (1 h, same constant as the cron's
//     "cache under 1 hour old" guard, so the two rules agree)
//   - after failures: wait 15 min, 30 min, 1 h, 2 h, 4 h, then 6 h (the cap)
//   A success resets the counter. The cap (6 h) is far below the daily cron
//   interval, so the backoff can never block the 02:00 run for a whole day.
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
}

/** Minimum gap after a success. Same value as the cron freshness guard on purpose. */
export const SUCCESS_MIN_GAP_MS = CRON_MIN_AGE_MS; // 1 hour
export const FAILURE_BACKOFF_BASE_MS = 15 * 60_000; // 15 minutes
export const FAILURE_BACKOFF_CAP_MS = 6 * 60 * 60_000; // 6 hours

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
  | { allowed: false; retryAt: number; reason: 'recent-success' | 'backoff'; consecutiveFailures: number };

/**
 * May a Space-Track login happen now?
 *
 * A stamp in the future (clock skew, a hand-edited file) is treated as "now", so
 * a bad file can delay the next attempt by at most one gap, never indefinitely.
 */
export function evaluateGate(state: AttemptState | null, now: number): GateDecision {
  if (!state) return { allowed: true };

  const last = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(last)) return { allowed: true };

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
  return {
    lastAttemptAt: new Date(now).toISOString(),
    lastOutcome: 'started',
    consecutiveFailures: priorFailures + 1,
  };
}

/** Transition: the attempt that began as `started` failed. The count is already in. */
export function stateOnFailure(started: AttemptState, now: number): AttemptState {
  return {
    lastAttemptAt: new Date(now).toISOString(),
    lastOutcome: 'failure',
    consecutiveFailures: Math.max(1, started.consecutiveFailures),
  };
}

/** Transition: success resets the counter. */
export function stateOnSuccess(now: number): AttemptState {
  return {
    lastAttemptAt: new Date(now).toISOString(),
    lastOutcome: 'success',
    consecutiveFailures: 0,
  };
}

/** Validate a parsed JSON value. Anything off -> null (treated as an empty log). */
export function parseAttemptState(raw: unknown): AttemptState | null {
  if (!raw || typeof raw !== 'object') return null;
  const { lastAttemptAt, lastOutcome, consecutiveFailures } = raw as Record<string, unknown>;
  if (typeof lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(lastAttemptAt))) return null;
  if (lastOutcome !== 'success' && lastOutcome !== 'failure' && lastOutcome !== 'started') return null;
  if (typeof consecutiveFailures !== 'number' || !Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    return null;
  }
  return { lastAttemptAt, lastOutcome, consecutiveFailures };
}

// ------------------------------------------------------------
// File I/O (never throws)
// ------------------------------------------------------------

export function attemptLogPath(): string {
  return path.join(cacheDir(), 'spacetrack-attempts.json');
}

/** Read the log. Missing -> null silently. Unreadable or corrupt -> null with one WARN. */
export function readAttemptState(): AttemptState | null {
  const p = attemptLogPath();
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`Space-Track attempt log unreadable (${(err as Error).message}) — treating as empty`);
    }
    return null;
  }

  try {
    const parsed = parseAttemptState(JSON.parse(text));
    if (!parsed) {
      logger.warn('Space-Track attempt log has an invalid shape — treating as empty');
    }
    return parsed;
  } catch {
    logger.warn('Space-Track attempt log is not valid JSON — treating as empty');
    return null;
  }
}

/** Atomic write: temp file in the same directory, then rename. Failure -> WARN, boot goes on. */
export function writeAttemptState(state: AttemptState): void {
  const p = attemptLogPath();
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    logger.warn(`Space-Track attempt log could not be written (${(err as Error).message}) — continuing without it`);
  }
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

export function recordSpaceTrackFailure(attempt: SpaceTrackAttempt, now: number): void {
  writeAttemptState(stateOnFailure(attempt.started, now));
}

export function recordSpaceTrackSuccess(now: number): void {
  writeAttemptState(stateOnSuccess(now));
}

/** One INFO line for a skipped attempt: says when the next one is allowed. */
export function describeSkippedAttempt(decision: Extract<GateDecision, { allowed: false }>, now: number): string {
  const waitMin = Math.max(1, Math.ceil((decision.retryAt - now) / 60_000));
  const why =
    decision.reason === 'recent-success'
      ? 'last Space-Track fetch succeeded less than 1 hour ago'
      : `backing off after ${decision.consecutiveFailures} failed attempt${decision.consecutiveFailures === 1 ? '' : 's'} in a row`;
  return (
    `Space-Track attempt skipped (${why}); will retry after ${new Date(decision.retryAt).toISOString()} ` +
    `(in about ${waitMin} min) — using the stale cache / CelesTrak meanwhile`
  );
}
