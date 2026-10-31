// ============================================================
// The nightly job: load the catalog -> screen -> write. Runs in the ssa-worker child process (src/ssa-worker.ts).
// ============================================================
import type { Pool } from 'pg';
import { getPool } from '../history/db/pool.js';
import { logger } from '../utils/logger.js';
import { loadCatalogFromDb } from './catalog.js';
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
}

export interface NightlyResult {
  status: 'written' | 'already-run' | 'dry-run' | 'no-catalog';
  batchTime: string;
  source: 'omm_updates' | 'fallback' | 'none';
  runId?: number;
  stats?: ScreenStats;
  encounters: number;
  inserted?: number;
  updated?: number;
  wallS: number;
}

/** Nightly schedule (UTC): half an hour after the 02:00 element-set ingest. */
export const SSA_CRON = '30 2 * * *';

const HOUR_MS = 3_600_000;

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

  let catalog = await loadCatalogFromDb(pool, batchTimeMs);
  let source: NightlyResult['source'] = 'omm_updates';
  if (catalog.length < minObjects && opts.fallback) {
    logger.warn(`SSA: omm_updates holds ${catalog.length} usable element sets (< ${minObjects}); using the current-GP cache`);
    catalog = await opts.fallback();
    source = 'fallback';
  }
  if (catalog.length < 2) {
    logger.warn(`SSA: no catalog for batch ${batchTime}; skipped`);
    return { status: 'no-catalog', batchTime, source: 'none', encounters: 0, wallS: wall() };
  }
  logger.info(`SSA: screening ${catalog.length} element sets (${source}) from ${batchTime} for ${opts.hours ?? 36} h`);

  const { encounters, stats } = await screenEncounters(catalog, batchTimeMs, opts);
  logger.info(`SSA: ${encounters.length} encounters among ${stats.objectsScreened} objects in ${stats.durationS} s (peak RSS ${stats.maxRssMB} MB)`);
  if (opts.dryRun) return { status: 'dry-run', batchTime, source, stats, encounters: encounters.length, wallS: wall() };

  const w = await writeRun(pool, {
    batchTimeMs, elementCutoffMs: stats.elementCutoffMs || null, objects: stats.objectsScreened, durationS: stats.durationS, codeVersion: SSA_CODE_VERSION,
  }, encounters);
  logger.info(w.written
    ? `SSA: run ${w.runId} written (${w.inserted} new, ${w.updated} updated)`
    : `SSA: run ${w.runId} for ${batchTime} already existed; nothing written`);
  return { status: w.written ? 'written' : 'already-run', batchTime, source, runId: w.runId, stats, encounters: encounters.length, inserted: w.inserted, updated: w.updated, wallS: wall() };
}
