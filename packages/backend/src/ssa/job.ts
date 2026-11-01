// ============================================================
// The nightly job as the worker runs it: catch-up over the missing days (changes, coverage) and the current screen, under the
// advisory lock. The parts are plain functions injected into runCatchUp (catchup.ts), so the loop itself is tested without
// SGP4 or files.
// ============================================================
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { runCatchUp, type CatchUpDeps, type CatchUpOpts, type CatchUpReport, type PartOutcome } from './catchup.js';
import { backfillDays } from './config.js';
import type { Part } from './day-status.js';
import { deriveDay } from './events/derive.js';
import { runNightly, type NightlyOpts } from './nightly.js';

export interface JobParts {
  /** coverage runner and existence check; absent = the coverage part is off */
  coverage?: { run: (pool: Pool, day: string) => Promise<PartOutcome>; exists: (day: string) => boolean };
  /** screen options (fallback catalog etc.) */
  screen?: Partial<NightlyOpts>;
}

export function jobDeps(pool: Pool, parts: JobParts = {}): CatchUpDeps {
  return {
    disabled: new Set<Part>(parts.coverage ? [] : ['coverage']),
    ...(parts.coverage ? { isPresent: (part: Part, day: string) => (part === 'coverage' ? parts.coverage!.exists(day) : true) } : {}),
    runPart: async (part, day): Promise<PartOutcome> => {
      if (part === 'changes') {
        const r = await deriveDay(pool, day);
        if (r.status === 'no-catalog') return { status: 'skipped', reason: `no-catalog (${r.prevObjects} before, ${r.curObjects} after)` };
        if (r.formationError) throw new Error(`formation pass failed: ${r.formationError}`);
        return { status: 'done', stats: r.perKind };
      }
      if (!parts.coverage) return { status: 'skipped', reason: 'coverage is off' };
      return parts.coverage.run(pool, day);
    },
    // changes of the screen's day were handled above, in order; the screen only reads the recent jumps
    runScreen: (batchTimeMs) => runNightly({ ...(parts.screen ?? {}), pool, batchTimeMs, skipChanges: true }),
  };
}

/** One tick: catch up, then screen. Never throws for an individual part. */
export async function runJob(pool: Pool, parts: JobParts = {}, o: CatchUpOpts = {}): Promise<CatchUpReport> {
  const rep = await runCatchUp(pool, jobDeps(pool, parts), { lookbackDays: backfillDays(), ...o });
  if (rep.locked) {
    const f = rep.processed.filter((p) => p.outcome !== 'done').length;
    logger.info(`SSA job: ${rep.processed.length - f} part-day(s) done, ${f} failed/skipped; screen ${rep.screen} (batch ${rep.batchTime})`);
  }
  return rep;
}
