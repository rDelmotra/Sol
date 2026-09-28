import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import type {
  CelesTrakGPElement,
  SpaceTrackGPElement,
} from '../../types/index.js';
import type { HistoryDimRow, HistoryFactRow } from '../types.js';
import { getPool, isHistoryReady } from '../db/pool.js';
import { upsertDailyBatch } from '../db/queries.js';
import { mapEnriched } from './map.js';
import { writeRawArchive } from '../archive/raw-writer.js';
import { logger } from '../../utils/logger.js';

// ============================================================
// Ingest sink — the shared, idempotent core.
//
// ingestEnriched() maps an EnrichedTLEObject[] to dim/fact rows, de-duplicates
// per conflict key (Postgres forbids touching a conflict target twice in one
// upsert), and writes them through the transactional upsert. The SAME function
// backs the daily cron AND the future Phase-2 backfill — daily-downsampling is
// emergent in the ON CONFLICT, so neither caller needs a separate collapse step.
// ============================================================

export type RawGpRecord = SpaceTrackGPElement | CelesTrakGPElement;

/**
 * Map + dedup, then upsert. Throws on DB error (caller decides fatality).
 *
 * Dedup keeps the row with the LATEST epoch for each key so an unsorted batch
 * (Phase-2 backfill) still collapses correctly before it reaches SQL.
 */
export async function ingestEnriched(
  objects: EnrichedTLEObject[],
  source: string,
): Promise<{ ingested: number; skipped: number }> {
  const pool = getPool();
  if (!pool) return { ingested: 0, skipped: objects.length };

  const dimByNorad = new Map<number, HistoryDimRow>();
  const factByKey = new Map<string, HistoryFactRow>();
  let skipped = 0;

  for (const obj of objects) {
    const mapped = mapEnriched(obj);
    if (!mapped) {
      skipped++;
      continue;
    }
    mapped.fact.source = source;

    // Dim: last write wins (static-ish metadata).
    dimByNorad.set(mapped.dim.norad_id, mapped.dim);

    // Fact: keep the latest epoch per (norad_id, utc_day).
    const key = `${mapped.fact.norad_id}:${mapped.fact.utc_day}`;
    const existing = factByKey.get(key);
    if (!existing || mapped.fact.epoch > existing.epoch) {
      factByKey.set(key, mapped.fact);
    }
  }

  const factRows = Array.from(factByKey.values());
  if (factRows.length === 0) return { ingested: 0, skipped };

  await upsertDailyBatch(pool, Array.from(dimByNorad.values()), factRows);
  return { ingested: factRows.length, skipped };
}

/**
 * Forward-collection entry point, fanned out from the daily TLE cron AFTER the
 * normal cache write. Best-effort archive of the raw GP, then the DB upsert.
 *
 * No-ops cleanly unless history is READY. Reuses the cron's single Space-Track
 * fetch — there is no second pull.
 */
export async function ingestCurrentGp(
  enriched: EnrichedTLEObject[],
  rawGp: RawGpRecord[] | null,
  source = 'unknown',
): Promise<void> {
  if (!isHistoryReady()) return;

  // Raw archive (source of truth) is insurance — its failure must not block the
  // DB ingest, which is the Phase-1 serving path.
  if (rawGp && rawGp.length > 0) {
    try {
      await writeRawArchive(rawGp, source);
    } catch (err) {
      logger.warn('History raw archive write failed (non-fatal):', (err as Error).message);
    }
  }

  const { ingested, skipped } = await ingestEnriched(enriched, source);
  logger.info(
    `History ingest: ${ingested} daily rows upserted from ${source}` +
      (skipped ? ` (${skipped} skipped)` : ''),
  );
}
