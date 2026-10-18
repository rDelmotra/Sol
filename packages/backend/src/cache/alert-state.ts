import path from 'path';
import { cacheDir } from '../utils/paths.js';
import { readStateFile, writeStateFile } from './state-file.js';

// ============================================================
// Alert memory for the alerts that are NOT the Space-Track "all 5 attempts failed"
// one (that one is remembered in spacetrack-attempts.json, see attempt-log.ts).
//
//   <CACHE_DIR>/alert-state.json
//   { volumeWarnDay?, volumeErrorDay?, writeFailureDay?, celestrakFallbackDay? }
//
// Each value is the UTC day ('YYYY-MM-DD') on which that alert last went out, so a
// restart does not repeat it and each alert goes out at most once per UTC day:
//   - volumeWarnDay / volumeErrorDay: the data volume is at >= 75% / >= 90% full
//   - writeFailureDay: the catalog could not be written to disk
//   - celestrakFallbackDay: CelesTrak was used as the fallback and its data was saved
//
// Same file rules as the other state files (state-file.ts): a missing, corrupt or
// unwritable file only logs a WARN and reads as "nothing sent yet". Because a full
// disk is exactly when the file cannot be written, what was sent in this process is
// also kept in memory, so a full disk does not repeat an alert within one run.
// ============================================================

export type AlertKind = 'volumeWarn' | 'volumeError' | 'writeFailure' | 'celestrakFallback';

export interface AlertState {
  volumeWarnDay?: string;
  volumeErrorDay?: string;
  writeFailureDay?: string;
  celestrakFallbackDay?: string;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const FIELD: Record<AlertKind, keyof AlertState> = {
  volumeWarn: 'volumeWarnDay',
  volumeError: 'volumeErrorDay',
  writeFailure: 'writeFailureDay',
  celestrakFallback: 'celestrakFallbackDay',
};

/** Days sent by this process, in case the file cannot be written. Keyed by file path. */
const sentInProcess = new Map<string, AlertState>();

export function alertStatePath(): string {
  return path.join(cacheDir(), 'alert-state.json');
}

/** Validate a parsed JSON value. Unknown keys and bad days are dropped; a non-object -> null. */
export function parseAlertState(raw: unknown): AlertState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const state: AlertState = {};
  for (const key of Object.values(FIELD)) {
    const v = r[key];
    if (typeof v === 'string' && DAY_PATTERN.test(v)) state[key] = v;
  }
  return state;
}

export function readAlertState(): AlertState {
  return readStateFile(alertStatePath(), 'Alert state', parseAlertState) ?? {};
}

/** The latest day this alert went out (file or this process), or undefined. */
export function lastAlertDay(kind: AlertKind): string | undefined {
  const field = FIELD[kind];
  const fromFile = readAlertState()[field];
  const fromMemory = sentInProcess.get(alertStatePath())?.[field];
  if (fromFile && fromMemory) return fromFile > fromMemory ? fromFile : fromMemory;
  return fromFile ?? fromMemory;
}

/** Has this alert already gone out on `day`? */
export function alertSentOn(kind: AlertKind, day: string): boolean {
  return lastAlertDay(kind) === day;
}

/** Remember that this alert went out on `day`. Never throws; a write failure is a WARN. */
export function markAlertSent(kind: AlertKind, day: string): void {
  const file = alertStatePath();
  const mem = sentInProcess.get(file) ?? {};
  mem[FIELD[kind]] = day;
  sentInProcess.set(file, mem);
  const state = readAlertState();
  state[FIELD[kind]] = day;
  writeStateFile(file, 'Alert state', state);
}

/** Forget what this process remembered (tests). */
export function resetAlertMemoryForTests(): void {
  sentInProcess.clear();
}
