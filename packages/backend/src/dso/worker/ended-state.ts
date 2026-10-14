/**
 * Persisted "this mission's ephemeris has ended" state for the DSO worker.
 *
 * Why: Horizons has no data after a mission ends. Without a memory of that, the
 * worker asks again every cycle, forever, and logs an ERROR each time. This file
 * remembers it across restarts so the worker can stop asking and keep serving
 * the ephemeris it already stored.
 *
 * File: <CACHE_DIR>/dso/ended.json
 *   { "objects": { "artemis-ii": { "endedAt": "<ISO>", "markedAt": "<ISO>", "lastCheckedAt": "<ISO>" } } }
 *   endedAt        last instant the provider has data for
 *   markedAt       when the worker first noticed that end
 *   lastCheckedAt  when the provider was last asked (or the flag set); an old file
 *                  without it uses markedAt
 *
 * An ended object is asked about again about once a week (DSO_ENDED_RECHECK_MS), in
 * case the provider published more data. Between checks it is left alone.
 *
 * Rules:
 *  - Written through a temp file and an atomic rename.
 *  - It only holds this flag. It never reads, rewrites or deletes snapshots, the
 *    manifest or the catalog.
 *  - A missing, unreadable or corrupt file means "nothing is ended" (and a WARN
 *    for the corrupt/unreadable case). The worker then behaves as it did before.
 *
 * Manual reset (new data appeared for a finished mission, and you do not want to wait
 * for the weekly check), any one of:
 *  - set DSO_RETRY_ENDED=1 and restart: each ended object is tried once per boot;
 *    if Horizons now has live data the flag is cleared by itself. Unset it after.
 *  - delete the object's entry from ended.json (or the whole file) and restart.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../../utils/atomic-write.js';
import { dsoCacheRoot } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

/** An ended object is asked about again after this long (about weekly). */
export const DSO_ENDED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DsoEndedRecord {
  /** Last instant the provider has data for (ISO). */
  endedAt: string;
  /** When the worker first noticed that end (ISO). */
  markedAt: string;
  /** When the provider was last asked, or the flag was last confirmed (ISO). */
  lastCheckedAt: string;
}

export interface DsoEndedState {
  objects: Record<string, DsoEndedRecord>;
}

export function getDsoEndedStatePath(): string {
  return path.join(dsoCacheRoot(), 'ended.json');
}

function emptyState(): DsoEndedState {
  return { objects: {} };
}

/** Validate parsed JSON; drop entries that are not well formed. */
export function parseDsoEndedState(raw: unknown): DsoEndedState | null {
  if (!raw || typeof raw !== 'object') return null;
  const objects = (raw as { objects?: unknown }).objects;
  if (!objects || typeof objects !== 'object' || Array.isArray(objects)) return null;

  const clean: Record<string, DsoEndedRecord> = {};
  for (const [dsoId, value] of Object.entries(objects as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const { endedAt, markedAt, lastCheckedAt } = value as Record<string, unknown>;
    if (typeof endedAt !== 'string' || !Number.isFinite(Date.parse(endedAt))) continue;
    const marked = typeof markedAt === 'string' && Number.isFinite(Date.parse(markedAt)) ? markedAt : endedAt;
    clean[dsoId] = {
      endedAt,
      markedAt: marked,
      lastCheckedAt:
        typeof lastCheckedAt === 'string' && Number.isFinite(Date.parse(lastCheckedAt)) ? lastCheckedAt : marked,
    };
  }
  return { objects: clean };
}

/** True when an ended object is due to be asked about again (about a week since the last check). */
export function isDsoEndedRecheckDue(
  record: DsoEndedRecord,
  now: Date,
  intervalMs: number = DSO_ENDED_RECHECK_MS,
): boolean {
  const last = Date.parse(record.lastCheckedAt);
  // A stamp that is not a date, or lies in the future (clock skew, a hand-edited file),
  // cannot be trusted. Check now: a successful check writes a good stamp over it.
  if (!Number.isFinite(last) || last > now.getTime()) return true;
  return now.getTime() - last >= intervalMs;
}

/**
 * Never throws. Missing -> empty. Unreadable or corrupt -> empty, with one WARN.
 * `quiet` skips the WARN (for /health, which is polled often).
 */
export async function readDsoEndedState(options: { quiet?: boolean } = {}): Promise<DsoEndedState> {
  const warn = (message: string): void => {
    if (!options.quiet) logger.warn(message);
  };

  let text: string;
  try {
    text = await fs.readFile(getDsoEndedStatePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`DSO ended-state file unreadable (${(error as Error).message}) — treating as empty`);
    }
    return emptyState();
  }

  try {
    const parsed = parseDsoEndedState(JSON.parse(text));
    if (!parsed) {
      warn('DSO ended-state file has an invalid shape — treating as empty');
      return emptyState();
    }
    return parsed;
  } catch {
    warn('DSO ended-state file is not valid JSON — treating as empty');
    return emptyState();
  }
}

/**
 * Mark an object as ended, or confirm that it still is (a re-check that found the same
 * end keeps the original markedAt and only moves lastCheckedAt).
 * Throws if the file cannot be written; callers decide what that means.
 */
export async function markDsoEnded(
  dsoId: string,
  endedAt: Date | string,
  now: Date = new Date(),
): Promise<DsoEndedState> {
  const state = await readDsoEndedState();
  const endedAtIso = typeof endedAt === 'string' ? endedAt : endedAt.toISOString();
  const previous = state.objects[dsoId];
  state.objects[dsoId] = {
    endedAt: endedAtIso,
    markedAt: previous && previous.endedAt === endedAtIso ? previous.markedAt : now.toISOString(),
    lastCheckedAt: now.toISOString(),
  };
  await atomicWriteJson(getDsoEndedStatePath(), state);
  return state;
}

/** Remove one entry. Throws if the file cannot be written. No-op when absent. */
export async function clearDsoEnded(dsoId: string): Promise<DsoEndedState> {
  const state = await readDsoEndedState();
  if (!(dsoId in state.objects)) return state;
  delete state.objects[dsoId];
  await atomicWriteJson(getDsoEndedStatePath(), state);
  return state;
}
