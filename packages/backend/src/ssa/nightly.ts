// ============================================================
// The nightly job: derive the previous day's changes -> load the catalog -> screen (with the recent-manoeuvre flags) -> write. Runs in the ssa-worker child process (src/ssa-worker.ts).
// ============================================================
import type { Pool } from 'pg';
import { getPool } from '../history/db/pool.js';
import { logger } from '../utils/logger.js';
import { loadCatalogFromDb } from './catalog.js';
import { deriveDay, type DeriveDayResult } from './events/derive.js';
import { loadRecentJumps, previousUtcDay } from './events/catalog.js';
import { RECENT_JUMP_DAYS } from './events/types.js';
import { screenEncounters } from './screen.js';
import { writeRun, SSA_CODE_VERSION } from './writer.js';
import type { ScreenOpts, ScreenStats, SsaObject } from './types.js';

export interface NightlyOpts extends ScreenOpts {
  /** batch time, UTC ms. Default: now rounded down to the hour (so a re-run within the hour is the same run). */
  batchTimeMs?: number;
  /** database pool; default the history pool (DATABASE_URL) */
  pool?: Pool;
  /**
   * Used when omm_updates holds fewer than `minObjects` usable element sets (e.g. before the first ingest filled it): the app's
   * current element sets, read by the caller from the existing current-GP cache.
   */
  fallback?: () => Promise<SsaObject[]> | SsaObject[];
  minObjects?: number;
  /** screen and report, but do not write */
  dryRun?: boolean;
  /** UTC day ('YYYY-MM-DD') to derive changes for; default the day before the batch time's day (the last complete day) */
  changeDay?: string;
  /** do not derive changes (the recent-manoeuvre flags are still read from ssa_event) */
  skipChanges?: boolean;
}

export interface NightlyResult {
  status: 'written' | 'already-run' | 'dry-run' | 'no-catalog';
  batchTime: string;
  source: 'omm_updates' | 'fallback' | 'none';
  runId?: number;
  stats?: ScreenStats;
  /** change detection of the previous day: its result, or the error that stopped it (the screen goes on without it) */
  changes?: DeriveDayResult | { status: 'failed'; day: string; error: string } | { status: 'skipped' };
  /** objects with an orbit change in the last 7 days that were handed to the screen as flags (0 when the lookup failed) */
  manoeuvredObjects?: number;
  encounters: number;
  inserted?: number;
  updated?: number;
  wallS: number;
}

/** Nightly schedule (UTC): half an hour after the 02:00 element-set ingest. */
export const SSA_CRON = '30 2 * * *';

const HOUR_MS = 3_600_000;

/** The run statistics without the formation list (a few hundred pairs; kept for callers of screenEncounters, not for the job's log line). */
const slim = (s: ScreenStats): ScreenStats => ({ ...s, formationList: [] });

export async function runNightly(opts: NightlyOpts = {}): Promise<NightlyResult> {
  const T = Date.now();
  const batchTimeMs = opts.batchTimeMs ?? Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const batchTime = new Date(batchTimeMs).toISOString();
  const pool = opts.pool ?? getPool();
  if (!pool) throw new Error('ssa: no database (DATABASE_URL is not set)');
  const minObjects = opts.minObjects ?? 1000;
  const wall = () => +((Date.now() - T) / 1000).toFixed(1);

  // already screened? (the unique batch_time makes the write a no-op too; this just saves the compute)
  if (!opts.dryRun) {
    const ex = await pool.query<{ id: string }>('SELECT id FROM ssa_run WHERE batch_time = $1', [batchTime]);
    if (ex.rowCount) {
      logger.info(`SSA: batch ${batchTime} was already screened (run ${ex.rows[0]!.id}); nothing to do`);
      return { status: 'already-run', batchTime, source: 'none', runId: Number(ex.rows[0]!.id), encounters: 0, wallS: wall() };
    }
  }

  // change detection first: the screen reads its orbit changes. A failure here must not stop the screen.
  const changeDay = opts.changeDay ?? previousUtcDay(batchTimeMs);
  let changes: NightlyResult['changes'] = { status: 'skipped' };
  if (!opts.skipChanges) {
    try {
      changes = await deriveDay(pool, changeDay, { ...(opts.dryRun ? { dryRun: true } : {}), ...(opts.minObjects !== undefined ? { minObjects: opts.minObjects } : {}) });
    } catch (err) {
      changes = { status: 'failed', day: changeDay, error: (err as Error).message };
      logger.error(`SSA: change detection for ${changeDay} failed (continuing without it): ${(err as Error).message}`);
    }
  }
  let recentJumps: Map<number, number> | undefined;
  try {
    recentJumps = await loadRecentJumps(pool, batchTimeMs, RECENT_JUMP_DAYS);
  } catch (err) {
    logger.error(`SSA: cannot read recent orbit changes (screening without manoeuvre flags): ${(err as Error).message}`);
  }

  let catalog = await loadCatalogFromDb(pool, batchTimeMs);
  let source: NightlyResult['source'] = 'omm_updates';
  if (catalog.length < minObjects && opts.fallback) {
    logger.warn(`SSA: omm_updates holds ${catalog.length} usable element sets (< ${minObjects}); using the current-GP cache`);
    catalog = await opts.fallback();
    source = 'fallback';
  }
  if (catalog.length < 2) {
    logger.warn(`SSA: no catalog for batch ${batchTime}; skipped`);
    return { status: 'no-catalog', batchTime, source: 'none', changes, encounters: 0, wallS: wall() };
  }
  logger.info(`SSA: screening ${catalog.length} element sets (${source}) from ${batchTime} for ${opts.hours ?? 36} h`);

  const { encounters, stats } = await screenEncounters(catalog, batchTimeMs, { ...opts, ...(recentJumps ? { recentJumps } : {}) });
  logger.info(`SSA: ${encounters.length} encounters among ${stats.objectsScreened} objects in ${stats.durationS} s (peak RSS ${stats.maxRssMB} MB)`);
  if (opts.dryRun) return { status: 'dry-run', batchTime, source, stats: slim(stats), changes, manoeuvredObjects: recentJumps?.size ?? 0, encounters: encounters.length, wallS: wall() };

  const w = await writeRun(pool, {
    batchTimeMs, elementCutoffMs: stats.elementCutoffMs || null, objects: stats.objectsScreened, durationS: stats.durationS, codeVersion: SSA_CODE_VERSION,
  }, encounters);
  logger.info(w.written
    ? `SSA: run ${w.runId} written (${w.inserted} new, ${w.updated} updated)`
    : `SSA: run ${w.runId} for ${batchTime} already existed; nothing written`);
  return { status: w.written ? 'written' : 'already-run', batchTime, source, runId: w.runId, stats: slim(stats), changes, manoeuvredObjects: recentJumps?.size ?? 0, encounters: encounters.length, inserted: w.inserted, updated: w.updated, wallS: wall() };
}

/** Derive the changes of one UTC day only (no screen): `ssa-worker --once --day YYYY-MM-DD`. Idempotent per day. */
export async function runChanges(day: string, opts: { pool?: Pool; dryRun?: boolean; skipFormation?: boolean; minObjects?: number } = {}): Promise<DeriveDayResult> {
  const pool = opts.pool ?? getPool();
  if (!pool) throw new Error('ssa: no database (DATABASE_URL is not set)');
  return deriveDay(pool, day, { ...(opts.dryRun ? { dryRun: true } : {}), ...(opts.skipFormation ? { skipFormation: true } : {}), ...(opts.minObjects !== undefined ? { minObjects: opts.minObjects } : {}) });
}
