// ============================================================
// "The catalog as of day D" from omm_updates: per object the latest element set with epoch before D + 1 day 00:00 UTC, within the
// window the spike's daily catalog files used (epoch within CATALOG_WINDOW_DAYS of that instant). Joined with object_dim /
// omm_daily for the name, regime and launch date; perigee / apogee come from the element set itself.
// ============================================================
import type { Pool } from 'pg';
import { summarizeOrbit } from '../../utils/orbit-summary.js';
import { CATALOG_WINDOW_DAYS, DAY_MS, type ChangeObject } from './types.js';

export const dayStartMs = (day: string): number => Date.parse(day + 'T00:00:00Z');
export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const prevDay = (day: string): string => isoDay(dayStartMs(day) - DAY_MS);
/** The UTC day before the one containing `ms`: the last complete day when the nightly job runs at 02:30. */
export const previousUtcDay = (ms: number): string => isoDay(Math.floor(ms / DAY_MS) * DAY_MS - DAY_MS);

export async function loadDayCatalog(pool: Pool, day: string, windowDays = CATALOG_WINDOW_DAYS): Promise<ChangeObject[]> {
  const end = dayStartMs(day) + DAY_MS;
  const r = await pool.query<{
    norad_id: number; omm: Record<string, unknown>; object_name: string | null; launch_date: string | null; regime: string | null;
  }>(
    `SELECT u.norad_id, u.omm, d.object_name, to_char(d.launch_date, 'YYYY-MM-DD') AS launch_date, f.regime
     FROM (
       SELECT DISTINCT ON (norad_id) norad_id, omm FROM omm_updates
       WHERE epoch < to_timestamp($1::float8 / 1000.0) AND epoch >= to_timestamp($1::float8 / 1000.0) - make_interval(days => $2::int)
       ORDER BY norad_id, epoch DESC
     ) u
     LEFT JOIN object_dim d ON d.norad_id = u.norad_id
     LEFT JOIN LATERAL (SELECT regime FROM omm_daily o WHERE o.norad_id = u.norad_id ORDER BY o.utc_day DESC LIMIT 1) f ON true
     ORDER BY u.norad_id`,
    [end, windowDays],
  );
  return r.rows.map((x): ChangeObject => {
    const o: ChangeObject = { noradId: x.norad_id, name: x.object_name || String(x.omm.OBJECT_NAME ?? ''), regime: x.regime ?? 'OTHER', omm: x.omm };
    const s = summarizeOrbit(Number(x.omm.MEAN_MOTION), Number(x.omm.ECCENTRICITY));
    if (s) { o.perigee = s.perigee; o.apogee = s.apogee; }
    if (x.launch_date) o.launchDate = x.launch_date;
    return o;
  });
}

/** First day each of `ids` was catalogued (object_dim.first_seen), for the `returned` class of object.appeared. */
export async function loadFirstSeen(pool: Pool, ids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (!ids.length) return m;
  const r = await pool.query<{ norad_id: number; first_seen: string }>(
    `SELECT norad_id, to_char(first_seen, 'YYYY-MM-DD') AS first_seen FROM object_dim WHERE norad_id = ANY($1::int[])`, [ids]);
  for (const x of r.rows) m.set(x.norad_id, x.first_seen);
  return m;
}

/**
 * NORAD id -> time (UTC ms) of the latest elements.jump with t_end in (batchTimeMs - days, batchTimeMs]: the objects that
 * manoeuvred recently, as the screener's flags. Causal: a jump whose new element set is dated after the batch is not known yet.
 */
export async function loadRecentJumps(pool: Pool, batchTimeMs: number, days = 7): Promise<Map<number, number>> {
  const r = await pool.query<{ id: number; t: string }>(
    `SELECT subjects[1] AS id, max(extract(epoch FROM t_end) * 1000) AS t FROM ssa_event
     WHERE kind = 'elements.jump' AND t_end <= to_timestamp($1::float8 / 1000.0) AND t_end > to_timestamp($1::float8 / 1000.0) - make_interval(days => $2::int)
     GROUP BY subjects[1]`,
    [batchTimeMs, days],
  );
  return new Map(r.rows.map((x) => [x.id, Math.round(Number(x.t))]));
}
