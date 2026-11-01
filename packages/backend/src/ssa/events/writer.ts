// ============================================================
// Persistence of one day's derived events. ONE transaction: delete the day's rows of the kinds being written, insert the new rows.
// A re-run of the same day replaces its rows (idempotent per day and kind set); kinds not in `kinds` are left alone, so a day whose
// formation pass failed keeps its earlier close.formation rows.
// ============================================================
import type { Pool } from 'pg';
import type { ChangeKind, EventRow } from './types.js';

const BATCH = 20_000;

export interface WriteEventsResult { deleted: number; inserted: number; perKind: Record<string, number> }

export async function writeDayEvents(pool: Pool, day: string, kinds: readonly ChangeKind[], rows: EventRow[]): Promise<WriteEventsResult> {
  for (const r of rows) if (!kinds.includes(r.kind)) throw new Error(`writeDayEvents: row of kind ${r.kind} is not in the kind set`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const del = await c.query('DELETE FROM ssa_event WHERE day = $1::date AND kind = ANY($2::text[])', [day, kinds]);
    for (let o = 0; o < rows.length; o += BATCH) {
      const part = rows.slice(o, o + BATCH);
      await c.query(
        `INSERT INTO ssa_event (day, kind, subjects, t_start, t_end, payload)
         SELECT $1::date, k, s::int[], to_timestamp(ts / 1000.0), to_timestamp(te / 1000.0), p::jsonb
         FROM unnest($2::text[], $3::text[], $4::float8[], $5::float8[], $6::text[]) AS u(k, s, ts, te, p)`,
        [day, part.map((r) => r.kind), part.map((r) => `{${r.subjects.join(',')}}`), part.map((r) => r.tStart), part.map((r) => r.tEnd), part.map((r) => JSON.stringify(r.payload))],
      );
    }
    await c.query('COMMIT');
    const perKind: Record<string, number> = {};
    for (const r of rows) perKind[r.kind] = (perKind[r.kind] ?? 0) + 1;
    return { deleted: del.rowCount ?? 0, inserted: rows.length, perKind };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
