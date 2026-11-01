// ============================================================
// Per-day completion of the nightly job's parts (table ssa_day_status, migration 0005), and the pure computation of which days a
// part still has to process. Used by catchup.ts (the loop) and by the writers (they record completion with their output).
// ============================================================
import type { Pool, PoolClient } from 'pg';

export const PARTS = ['changes', 'coverage'] as const;
export type Part = (typeof PARTS)[number];

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dayStart = (day: string): number => Date.parse(day + 'T00:00:00Z');

type Q = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** Record that `part` finished for `day` (upsert; clears the failed-attempt record). Pass the transaction's client to do it atomically with the output. */
export async function markDone(q: Q, day: string, part: Part, stats: unknown = {}): Promise<void> {
  await q.query(
    `INSERT INTO ssa_day_status (day, part, done_at, stats) VALUES ($1::date, $2, now(), $3::jsonb)
     ON CONFLICT (day, part) DO UPDATE SET done_at = now(), stats = EXCLUDED.stats`,
    [day, part, JSON.stringify(stats ?? {})],
  );
}

/** Record a failed attempt (attempts + 1, last error). Never touches a day that is already done. */
export async function markFailed(q: Q, day: string, part: Part, error: string, nowMs = Date.now()): Promise<void> {
  await q.query(
    `INSERT INTO ssa_day_status (day, part, done_at, stats) VALUES ($1::date, $2, NULL, $3::jsonb)
     ON CONFLICT (day, part) DO UPDATE SET stats = jsonb_build_object(
         'attempts', COALESCE((ssa_day_status.stats->>'attempts')::int, 0) + 1,
         'lastAttemptAt', $4::bigint, 'error', $5::text)
       WHERE ssa_day_status.done_at IS NULL`,
    [day, part, JSON.stringify({ attempts: 1, lastAttemptAt: nowMs, error }), nowMs, error.slice(0, 500)],
  );
}

export interface StatusRow { day: string; part: Part; done: boolean; attempts: number; lastAttemptMs: number | null; error?: string }

export async function loadStatuses(pool: Q, fromDay: string, toDay: string): Promise<StatusRow[]> {
  const r = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, part, done_at IS NOT NULL AS done, stats FROM ssa_day_status WHERE day >= $1::date AND day <= $2::date`,
    [fromDay, toDay],
  ) as { rows: Array<{ day: string; part: Part; done: boolean; stats: { attempts?: number; lastAttemptAt?: number; error?: string } | null }> };
  return r.rows.map((x) => ({
    day: x.day, part: x.part, done: x.done,
    attempts: x.done ? 0 : Number(x.stats?.attempts ?? 0),
    lastAttemptMs: x.done ? null : (x.stats?.lastAttemptAt ?? null),
    ...(x.stats?.error ? { error: x.stats.error } : {}),
  }));
}

/** Number of element sets per UTC day of their epoch, for days in [fromDay, toDay] (days with none are absent). */
export async function countElementSetsByDay(pool: Q, fromDay: string, toDay: string): Promise<Map<string, number>> {
  const r = await pool.query(
    `SELECT to_char(epoch AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n FROM omm_updates
     WHERE epoch >= $1::date AND epoch < ($2::date + 1) GROUP BY 1`,
    [fromDay, toDay],
  ) as { rows: Array<{ day: string; n: number }> };
  return new Map(r.rows.map((x) => [x.day, x.n]));
}

export interface MissingOpts {
  part: Part;
  /** now, UTC ms */
  nowMs: number;
  /** how many days back from yesterday are looked at (>= 1) */
  lookbackDays: number;
  /** element sets per UTC day of epoch (countElementSetsByDay); must reach CATALOG_WINDOW_DAYS before the oldest candidate day */
  counts: Map<string, number>;
  /** a day needs at least this many element sets to count as having data (the daily ingest delivers ~28k) */
  minRows: number;
  /** parts already done: `${day}` set per part */
  done: Set<string>;
  /** failed attempts per day (not done) */
  failed: Map<string, { attempts: number; lastAttemptMs: number | null }>;
  /** a day is only taken once this long after its end (the 02:00 ingest delivers the last element sets of the day) */
  settleMs?: number;
  /** days of earlier data the catalog of a day may draw on (the catalog is built from the latest set per object within this window) */
  catalogWindowDays?: number;
  maxAttempts?: number;
  /** wait after a failed attempt: backoffBaseMs * 2^(attempts-1), capped at backoffMaxMs */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface MissingResult { days: string[]; skippedBackoff: string[]; gaveUp: string[] }

/**
 * The days (oldest first) that `part` still has to process: complete UTC days inside the look-back window that have element-set data
 * (changes also needs the catalog as of the day before, i.e. earlier data), are not done, and are not in back-off / given up.
 */
export function computeMissingDays(o: MissingOpts): MissingResult {
  const settle = o.settleMs ?? 2.5 * HOUR_MS;
  const win = o.catalogWindowDays ?? 30;
  const maxAttempts = o.maxAttempts ?? 5, base = o.backoffBaseMs ?? HOUR_MS, cap = o.backoffMaxMs ?? 24 * HOUR_MS;
  // last complete day: the one whose end + settle time has passed
  const lastDay = Math.floor((o.nowMs - settle) / DAY_MS) * DAY_MS - DAY_MS;
  const has = (ms: number): boolean => (o.counts.get(isoDay(ms)) ?? 0) >= o.minRows;
  const days: string[] = [], skippedBackoff: string[] = [], gaveUp: string[] = [];
  for (let t = lastDay - (Math.max(1, o.lookbackDays) - 1) * DAY_MS; t <= lastDay; t += DAY_MS) {
    const d = isoDay(t);
    if (o.done.has(d) || !has(t)) continue;
    if (o.part === 'changes') {
      // the catalog as of the end of the previous day: some element-set day within the catalog window before this one
      let prev = false;
      for (let k = 1; k <= win && !prev; k++) prev = has(t - k * DAY_MS);
      if (!prev) continue;
    }
    const f = o.failed.get(d);
    if (f && f.attempts >= maxAttempts) { gaveUp.push(d); continue; }
    if (f && f.lastAttemptMs !== null) {
      const wait = Math.min(cap, base * 2 ** (f.attempts - 1));
      if (o.nowMs < f.lastAttemptMs + wait) { skippedBackoff.push(d); continue; }
    }
    days.push(d);
  }
  return { days, skippedBackoff, gaveUp };
}

/**
 * The batch time of the screen the nightly schedule would have run last: 02:00 UTC of the latest day whose 02:30 tick has passed.
 * (Past forward screens are NOT backfilled: a 36 h screen of a past batch answers nothing today.)
 */
export function currentBatchTimeMs(nowMs: number, cronHourUtc = 2, cronMinuteUtc = 30): number {
  const d0 = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const slot = d0 + cronHourUtc * HOUR_MS + cronMinuteUtc * 60_000;
  const day = nowMs >= slot ? d0 : d0 - DAY_MS;
  return day + cronHourUtc * HOUR_MS;
}
