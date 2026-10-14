/**
 * Persisted "this mission's ephemeris has ended" state for the DSO worker.
 *
 * Why: Horizons has no data after a mission ends. Without a memory of that, the
 * worker asks again every cycle, forever, and logs an ERROR each time. This file
 * remembers it across restarts so the worker can stop asking and keep serving
 * the ephemeris it already stored.
 *
 * File: <CACHE_DIR>/dso/ended.json
 *   { "objects": { "artemis-ii": { "endedAt": "<ISO>", "markedAt": "<ISO>" } } }
 *
 * Rules:
 *  - Written through a temp file and an atomic rename.
 *  - It only holds this flag. It never reads, rewrites or deletes snapshots, the
 *    manifest or the catalog.
 *  - A missing, unreadable or corrupt file means "nothing is ended" (and a WARN
 *    for the corrupt/unreadable case). The worker then behaves as it did before.
 *
 * Manual reset (new data appeared for a finished mission), any one of:
 *  - set DSO_RETRY_ENDED=1 and restart: each ended object is tried once per boot;
 *    if Horizons now has live data the flag is cleared by itself. Unset it after.
 *  - delete the object's entry from ended.json (or the whole file) and restart.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../../utils/atomic-write.js';
import { dsoCacheRoot } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

export interface DsoEndedRecord {
  /** Last instant the provider has data for (ISO). */
  endedAt: string;
  /** When the worker noticed (ISO). */
  markedAt: string;
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
    const { endedAt, markedAt } = value as Record<string, unknown>;
    if (typeof endedAt !== 'string' || !Number.isFinite(Date.parse(endedAt))) continue;
    clean[dsoId] = {
      endedAt,
      markedAt: typeof markedAt === 'string' && Number.isFinite(Date.parse(markedAt)) ? markedAt : endedAt,
    };
  }
  return { objects: clean };
}

/** Never throws. Missing -> empty. Unreadable or corrupt -> empty, with one WARN. */
export async function readDsoEndedState(): Promise<DsoEndedState> {
  let text: string;
  try {
    text = await fs.readFile(getDsoEndedStatePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`DSO ended-state file unreadable (${(error as Error).message}) — treating as empty`);
    }
    return emptyState();
  }

  try {
    const parsed = parseDsoEndedState(JSON.parse(text));
    if (!parsed) {
      logger.warn('DSO ended-state file has an invalid shape — treating as empty');
      return emptyState();
    }
    return parsed;
  } catch {
    logger.warn('DSO ended-state file is not valid JSON — treating as empty');
    return emptyState();
  }
}

/** Throws if the file cannot be written; callers decide what that means. */
export async function markDsoEnded(
  dsoId: string,
  endedAt: Date | string,
  now: Date = new Date(),
): Promise<DsoEndedState> {
  const state = await readDsoEndedState();
  state.objects[dsoId] = {
    endedAt: typeof endedAt === 'string' ? endedAt : endedAt.toISOString(),
    markedAt: now.toISOString(),
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
