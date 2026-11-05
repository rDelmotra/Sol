// ============================================================
// The element sets a coverage day is built from and answered with: per object the latest set with epoch before the END of the day
// (within CATALOG_WINDOW_DAYS), from omm_updates, ordered by NORAD id. The build and every later refine of that day use exactly this
// set, so the lists and the answers agree. (Same rule as the change detector's day catalog, without its joins.)
// ============================================================
import type { Pool } from 'pg';
import { CATALOG_WINDOW_DAYS } from '../events/types.js';
import { DAY_MS } from './consts.js';
import type { PropagatorKind } from '../encounter.js';

/** `propagator` is set only by the history backfill (pre-1980 sets without B*: 'sgp'); absent = SGP4. */
export interface OmmObject { noradId: number; omm: Record<string, unknown>; propagator?: PropagatorKind }

export const dayStartMs = (day: string): number => Date.parse(day + 'T00:00:00Z');
export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

type Q = Pick<Pool, 'query'>;

export async function loadOmmCatalog(pool: Q, day: string, ids?: readonly number[]): Promise<OmmObject[]> {
  const end = dayStartMs(day) + DAY_MS;
  const r = await pool.query(
    `SELECT DISTINCT ON (norad_id) norad_id, omm FROM omm_updates
     WHERE epoch < to_timestamp($1::float8 / 1000.0) AND epoch >= to_timestamp($1::float8 / 1000.0) - make_interval(days => $2::int)
       ${ids ? 'AND norad_id = ANY($3::int[])' : ''}
     ORDER BY norad_id, epoch DESC`,
    ids ? [end, CATALOG_WINDOW_DAYS, ids as number[]] : [end, CATALOG_WINDOW_DAYS],
  ) as { rows: Array<{ norad_id: number; omm: Record<string, unknown> }> };
  return r.rows.map((x) => ({ noradId: x.norad_id, omm: x.omm }));
}

/** Names of objects (object_dim, else the element set's OBJECT_NAME is unavailable here: empty string). */
export async function loadNames(pool: Q, ids: readonly number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (!ids.length) return m;
  const r = await pool.query('SELECT norad_id, object_name FROM object_dim WHERE norad_id = ANY($1::int[])', [ids as number[]]) as { rows: Array<{ norad_id: number; object_name: string | null }> };
  for (const x of r.rows) m.set(x.norad_id, x.object_name ?? '');
  return m;
}
