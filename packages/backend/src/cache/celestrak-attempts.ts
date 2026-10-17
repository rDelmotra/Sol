import path from 'path';
import { cacheDir } from '../utils/paths.js';
import { readStateFile, writeStateFile } from './state-file.js';

// ============================================================
// CelesTrak attempt log
//
// CelesTrak's usage policy: its data changes only every 2 hours, and asking for the
// same group again sooner is answered with HTTP 403. Repeating after a 403 or 404
// can get the IP firewalled (50 such errors in 2 hours). So every CelesTrak GP
// download is written down here, per group, in
//   <CACHE_DIR>/celestrak-attempts.json
//   { "<group>": { lastAttemptAt, lastOutcome } }
//
// Rule (pure, see evaluateCelesTrakGate): no download of the same group within
// CELESTRAK_MIN_GAP_MS (2 h) of the last attempt, whether it succeeded or failed
// (a 403 or 404 included). Missing, corrupt or unwritable file -> allowed, WARN only.
// A stamp in the future counts as "now", so a bad file waits at most one gap.
// The attempt is written BEFORE the request ('started'), so a crash mid-download
// still holds the next one back.
//
// Same file rules as the Space-Track log (see state-file.ts): atomic write, never
// throws, never touches another file.
// ============================================================

export type CelesTrakOutcome = 'success' | 'failure' | 'started';

export interface CelesTrakGroupState {
  lastAttemptAt: string;
  lastOutcome: CelesTrakOutcome;
  /** HTTP status of the last failure, when there was one. Information only. */
  lastHttpStatus?: number;
}

export type CelesTrakAttempts = Record<string, CelesTrakGroupState>;

export const CELESTRAK_MIN_GAP_MS = 2 * 60 * 60_000; // 2 hours

export type CelesTrakGateDecision = { allowed: true } | { allowed: false; retryAt: number };

// ------------------------------------------------------------
// Pure policy
// ------------------------------------------------------------

export function evaluateCelesTrakGate(
  attempts: CelesTrakAttempts | null,
  group: string,
  now: number,
): CelesTrakGateDecision {
  const state = attempts?.[group];
  if (!state) return { allowed: true };
  const last = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(last)) return { allowed: true };
  const retryAt = Math.min(last, now) + CELESTRAK_MIN_GAP_MS;
  return now >= retryAt ? { allowed: true } : { allowed: false, retryAt };
}

/** Validate a parsed JSON value. Bad groups are dropped; a non-object -> null. */
export function parseCelesTrakAttempts(raw: unknown): CelesTrakAttempts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: CelesTrakAttempts = {};
  for (const [group, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const { lastAttemptAt, lastOutcome, lastHttpStatus } = value as Record<string, unknown>;
    if (typeof lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(lastAttemptAt))) continue;
    if (lastOutcome !== 'success' && lastOutcome !== 'failure' && lastOutcome !== 'started') continue;
    out[group] = {
      lastAttemptAt,
      lastOutcome,
      ...(typeof lastHttpStatus === 'number' && Number.isInteger(lastHttpStatus) ? { lastHttpStatus } : {}),
    };
  }
  return out;
}

// ------------------------------------------------------------
// File I/O (never throws)
// ------------------------------------------------------------

export function celesTrakAttemptsPath(): string {
  return path.join(cacheDir(), 'celestrak-attempts.json');
}

export function readCelesTrakAttempts(): CelesTrakAttempts | null {
  return readStateFile(celesTrakAttemptsPath(), 'CelesTrak attempt log', parseCelesTrakAttempts);
}

function writeGroup(group: string, state: CelesTrakGroupState): void {
  const all = readCelesTrakAttempts() ?? {};
  all[group] = state;
  writeStateFile(celesTrakAttemptsPath(), 'CelesTrak attempt log', all);
}

// ------------------------------------------------------------
// Wrappers used by the CelesTrak services
// ------------------------------------------------------------

export function checkCelesTrakGate(group: string, now: number): CelesTrakGateDecision {
  return evaluateCelesTrakGate(readCelesTrakAttempts(), group, now);
}

/** Persist a pending attempt BEFORE the request. */
export function beginCelesTrakAttempt(group: string, now: number): void {
  writeGroup(group, { lastAttemptAt: new Date(now).toISOString(), lastOutcome: 'started' });
}

export function recordCelesTrakSuccess(group: string, now: number): void {
  writeGroup(group, { lastAttemptAt: new Date(now).toISOString(), lastOutcome: 'success' });
}

export function recordCelesTrakFailure(group: string, now: number, httpStatus?: number): void {
  writeGroup(group, {
    lastAttemptAt: new Date(now).toISOString(),
    lastOutcome: 'failure',
    ...(httpStatus !== undefined ? { lastHttpStatus: httpStatus } : {}),
  });
}

/** One INFO line for a skipped download. */
export function describeSkippedCelesTrak(group: string, retryAt: number, now: number): string {
  const waitMin = Math.max(1, Math.ceil((retryAt - now) / 60_000));
  return (
    `CelesTrak ${group} download skipped (CelesTrak data updates only every 2 hours and repeats can get the IP blocked); ` +
    `next one allowed after ${new Date(retryAt).toISOString()} (in about ${waitMin} min)`
  );
}
