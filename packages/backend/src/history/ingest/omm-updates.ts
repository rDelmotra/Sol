import type { Pool } from 'pg';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';

// ============================================================
// omm_updates writer — keeps EVERY element set that reaches the daily ingest (omm_daily keeps one per object per day).
// Idempotent: the (norad_id, epoch) unique key plus ON CONFLICT DO NOTHING, so a re-ingest or an overlapping fetch adds nothing.
// The encounter screener (src/ssa) reads its causal catalog from this table.
// ============================================================

const CHUNK = 5000;

/** Insert the element sets; returns the number of NEW rows. Objects with an unparseable epoch are skipped. */
export async function insertOmmUpdates(pool: Pool, objects: EnrichedTLEObject[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < objects.length; i += CHUNK) {
    const ids: number[] = [], epochs: string[] = [], omms: string[] = [];
    for (const o of objects.slice(i, i + CHUNK)) {
      const ep = new Date(o.epoch);
      if (Number.isNaN(ep.getTime())) continue;
      ids.push(o.noradId);
      epochs.push(ep.toISOString());
      omms.push(JSON.stringify(o.omm));
    }
    if (ids.length === 0) continue;
    const r = await pool.query(
      `INSERT INTO omm_updates (norad_id, epoch, omm)
       SELECT u.id, u.ep, u.omm::jsonb FROM unnest($1::int[], $2::timestamptz[], $3::text[]) AS u(id, ep, omm)
       ON CONFLICT (norad_id, epoch) DO NOTHING`,
      [ids, epochs, omms],
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}
