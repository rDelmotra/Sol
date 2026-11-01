// ============================================================
// The catch-up loop of the nightly job. At worker start-up and on every cron tick it looks, per part ('changes', 'coverage'), for
// the complete UTC days inside a bounded look-back window that have element-set data but no completion record (ssa_day_status),
// and processes them oldest first, one at a time (a day: changes, then coverage — each part independent: one failing does not
// stop the other or the next day). Then it runs the current 36 h screen when the latest run is older than the current batch time.
//
//   - Only the CURRENT batch is screened. Past forward screens are not backfilled: a 36 h window that ended days ago answers no
//     question anyone asks today, and the encounter history is a by-product of runs that really happened.
//   - A failing day is recorded (attempts, error) and retried on later ticks with exponential back-off, up to a maximum number of
//     attempts; it is never retried in a tight loop. `--once --day` forces a day regardless.
//   - A Postgres advisory lock (one dedicated connection) makes concurrent runs of the job impossible across processes; a tick that
//     finds the lock taken skips.
// ============================================================
import type { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger.js';
import {
  PARTS, computeMissingDays, countElementSetsByDay, currentBatchTimeMs, dayStart, isoDay, loadStatuses, markFailed, DAY_MS,
  type MissingResult, type Part,
} from './day-status.js';

/** pg_try_advisory_lock key pair (arbitrary constants: 'SSA' + 'CU'). */
const LOCK_KEY: [number, number] = [0x535341, 0x4355];

export type LockResult<T> = { locked: true; value: T } | { locked: false };

/** Run `fn` while holding the job's advisory lock; `{locked:false}` immediately when another connection holds it. */
export async function withJobLock<T>(pool: Pool, fn: () => Promise<T>, key: [number, number] = LOCK_KEY): Promise<LockResult<T>> {
  const c: PoolClient = await pool.connect();
  let got = false;
  try {
    const r = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', key);
    got = r.rows[0]!.ok;
    if (!got) return { locked: false };
    return { locked: true, value: await fn() };
  } finally {
    if (got) await c.query('SELECT pg_advisory_unlock($1::int, $2::int)', key).catch(() => undefined);
    c.release();
  }
}

/** What a part's runner reports. The runner records completion itself (same transaction / step as its output). */
export type PartOutcome = { status: 'done'; stats?: unknown } | { status: 'skipped'; reason: string };

export interface CatchUpDeps {
  runPart: (part: Part, day: string) => Promise<PartOutcome>;
  /** parts that are switched off (e.g. coverage without a volume) */
  disabled?: ReadonlySet<Part>;
  /** extra "is it really done" check on top of the status row (coverage: the files exist) */
  isPresent?: (part: Part, day: string) => Promise<boolean> | boolean;
  /** screen the current batch (the latest run is older than `batchTimeMs`) */
  runScreen: (batchTimeMs: number) => Promise<unknown>;
}

export interface CatchUpOpts {
  nowMs?: number;
  lookbackDays?: number;
  minRows?: number;
  settleMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** advisory lock key (tests use their own so parallel test processes sharing a database do not exclude each other) */
  lockKey?: [number, number];
}

export interface CatchUpReport {
  locked: boolean;
  /** days processed, in order, with the outcome of each part */
  processed: Array<{ day: string; part: Part; outcome: 'done' | 'skipped' | 'failed'; error?: string }>;
  skippedBackoff: Record<Part, string[]>;
  gaveUp: Record<Part, string[]>;
  screen: 'ran' | 'up-to-date' | 'failed' | 'not-run';
  batchTime: string;
}

const emptyReport = (batchMs: number): CatchUpReport => ({
  locked: true, processed: [], skippedBackoff: { changes: [], coverage: [] }, gaveUp: { changes: [], coverage: [] }, screen: 'not-run', batchTime: new Date(batchMs).toISOString(),
});

/** The missing days of each part for `nowMs` (reads the status table and the element-set day counts). */
export async function findMissing(pool: Pool, deps: Pick<CatchUpDeps, 'disabled' | 'isPresent'>, o: CatchUpOpts = {}): Promise<Record<Part, MissingResult>> {
  const nowMs = o.nowMs ?? Date.now();
  const lookback = Math.max(1, o.lookbackDays ?? 30);
  const lastDayMs = Math.floor((nowMs - (o.settleMs ?? 2.5 * 3_600_000)) / DAY_MS) * DAY_MS - DAY_MS;
  const firstDay = isoDay(lastDayMs - (lookback - 1) * DAY_MS), lastDay = isoDay(lastDayMs);
  const counts = await countElementSetsByDay(pool, isoDay(dayStart(firstDay) - 31 * DAY_MS), lastDay);
  const statuses = await loadStatuses(pool, firstDay, lastDay);
  const out = {} as Record<Part, MissingResult>;
  for (const part of PARTS) {
    if (deps.disabled?.has(part)) { out[part] = { days: [], skippedBackoff: [], gaveUp: [] }; continue; }
    const done = new Set<string>(), failed = new Map<string, { attempts: number; lastAttemptMs: number | null }>();
    for (const s of statuses) {
      if (s.part !== part) continue;
      if (s.done) done.add(s.day); else failed.set(s.day, { attempts: s.attempts, lastAttemptMs: s.lastAttemptMs });
    }
    if (deps.isPresent) for (const d of [...done]) if (!(await deps.isPresent(part, d))) done.delete(d); // marked done but the output is gone
    out[part] = computeMissingDays({
      part, nowMs, lookbackDays: lookback, counts, minRows: o.minRows ?? 1000, done, failed,
      ...(o.settleMs !== undefined ? { settleMs: o.settleMs } : {}),
      ...(o.maxAttempts !== undefined ? { maxAttempts: o.maxAttempts } : {}),
      ...(o.backoffBaseMs !== undefined ? { backoffBaseMs: o.backoffBaseMs } : {}),
      ...(o.backoffMaxMs !== undefined ? { backoffMaxMs: o.backoffMaxMs } : {}),
    });
  }
  return out;
}

async function latestRunMs(pool: Pool): Promise<number | null> {
  const r = await pool.query<{ t: string | null }>('SELECT extract(epoch FROM max(batch_time)) * 1000 AS t FROM ssa_run');
  const t = r.rows[0]?.t;
  return t === null || t === undefined ? null : Number(t);
}

/** One pass of the loop, under the advisory lock. */
export async function runCatchUp(pool: Pool, deps: CatchUpDeps, o: CatchUpOpts = {}): Promise<CatchUpReport> {
  const nowMs = o.nowMs ?? Date.now();
  const batchMs = currentBatchTimeMs(nowMs);
  const res = await withJobLock(pool, async (): Promise<CatchUpReport> => {
    const rep = emptyReport(batchMs);
    const missing = await findMissing(pool, deps, o);
    for (const part of PARTS) { rep.skippedBackoff[part] = missing[part].skippedBackoff; rep.gaveUp[part] = missing[part].gaveUp; }
    const days = [...new Set(PARTS.flatMap((p) => missing[p].days))].sort();
    logger.info(`SSA catch-up: ${days.length} day(s) to process${days.length ? ` (${days[0]}..${days[days.length - 1]})` : ''}; changes ${missing.changes.days.length}, coverage ${missing.coverage.days.length}`);
    for (const day of days) {
      for (const part of PARTS) {
        if (!missing[part].days.includes(day)) continue;
        const t0 = Date.now();
        try {
          const out = await deps.runPart(part, day);
          if (out.status === 'done') {
            rep.processed.push({ day, part, outcome: 'done' });
            logger.info(`SSA catch-up: ${part} ${day} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
          } else {
            await markFailed(pool, day, part, out.reason, nowMs);
            rep.processed.push({ day, part, outcome: 'skipped', error: out.reason });
            logger.warn(`SSA catch-up: ${part} ${day} skipped (${out.reason})`);
          }
        } catch (err) {
          const msg = (err as Error).message;
          await markFailed(pool, day, part, msg, nowMs).catch(() => undefined);
          rep.processed.push({ day, part, outcome: 'failed', error: msg });
          logger.error(`SSA catch-up: ${part} ${day} failed (will retry on a later tick): ${msg}`);
        }
      }
    }
    const last = await latestRunMs(pool);
    if (last !== null && last >= batchMs) {
      rep.screen = 'up-to-date';
    } else {
      try { await deps.runScreen(batchMs); rep.screen = 'ran'; }
      catch (err) { rep.screen = 'failed'; logger.error(`SSA catch-up: screen of ${rep.batchTime} failed: ${(err as Error).message}`); }
    }
    return rep;
  }, o.lockKey);
  if (!res.locked) {
    logger.warn('SSA catch-up: another process holds the job lock; skipping this run');
    return { ...emptyReport(batchMs), locked: false };
  }
  return res.value;
}
