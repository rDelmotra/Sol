// ============================================================
// object.breakup rows in ssa_event: replace them (idempotent) and read the appeared events they are derived from.
// ============================================================
import type { Pool } from 'pg';
import { BREAKUP_KIND } from '../events/types.js';
import type { AppearedRef } from './breakup.js';
import type { BreakupLine } from './breakup-files.js';

/** Replace all object.breakup rows whose day is in [from, to] (open ends allowed) by `lines`, in ONE transaction. Returns rows deleted / inserted. */
export async function replaceBreakups(pool: Pool, lines: readonly BreakupLine[], range: { from?: string; to?: string } = {}): Promise<{ deleted: number; inserted: number }> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const del = await c.query('DELETE FROM ssa_event WHERE kind = $1 AND day >= $2::date AND day <= $3::date', [BREAKUP_KIND, range.from ?? '0001-01-01', range.to ?? '9999-12-31']);
    if (lines.length) {
      await c.query(
        `INSERT INTO ssa_event (day, kind, subjects, t_start, t_end, payload)
         SELECT d::date, $1, s::int[], t1::timestamptz, t2::timestamptz, p::jsonb
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u(d, s, t1, t2, p)`,
        [BREAKUP_KIND, lines.map((l) => l.day), lines.map((l) => `{${l.subjects.join(',')}}`), lines.map((l) => l.t_start), lines.map((l) => l.t_end), lines.map((l) => JSON.stringify(l.payload))],
      );
    }
    await c.query('COMMIT');
    return { deleted: del.rowCount ?? 0, inserted: lines.length };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** The object.appeared events in ssa_event (one object per row), optionally only days in [from, to]. */
export async function loadAppearedFromDb(pool: Pool, range: { from?: string; to?: string } = {}): Promise<AppearedRef[]> {
  const { rows } = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, subjects[1] AS norad, payload->>'cls' AS cls
       FROM ssa_event WHERE kind = 'object.appeared' AND day >= $1::date AND day <= $2::date AND cardinality(subjects) > 0
      ORDER BY day, id`,
    [range.from ?? '0001-01-01', range.to ?? '9999-12-31'],
  ) as { rows: Array<{ day: string; norad: number; cls: string | null }> };
  return rows.map((r) => ({ noradId: r.norad, day: r.day, cls: r.cls }));
}
