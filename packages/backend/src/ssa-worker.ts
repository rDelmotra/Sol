import 'dotenv/config';
import cron from 'node-cron';
import { readCache } from './cache/file-cache.js';
import { closeHistory, initHistory, isHistoryEnabled } from './history/index.js';
import { coverageEnabled, coverageJobPart, runCoverageDay, fromEnriched, runChanges, runJob, runNightly, withJobLock, SSA_CRON, type NightlyOpts, type NightlyResult } from './ssa/index.js';
import { getPool } from './history/db/pool.js';
import { logger } from './utils/logger.js';

// ============================================================
// SSA worker — the nightly encounter screening, as a supervisor child (non-critical, only spawned when DATABASE_URL is set).
//
//   node dist/ssa-worker.js                 catch up at start-up, then at 02:30 UTC every day (the 02:00 ingest has filled omm_updates by then).
//                                           A catch-up pass (ssa/job.ts) processes, oldest first, every complete day of the last
//                                           SSA_BACKFILL_DAYS (default 30) that has element sets but no completion record in ssa_day_status
//                                           (change detection, star-map coverage), then screens the current batch if it is not there yet.
//                                           A Postgres advisory lock keeps two processes from running it at once.
//   node dist/ssa-worker.js --once --catch-up
//                                           one catch-up pass now and exit
//   node dist/ssa-worker.js --once [--batch-time 2026-10-12T12:00:00Z] [--hours 36] [--dry-run] [--skip-changes]
//                                           run one screening now and exit (0 = ok); it first derives the previous UTC day's changes
//                                           (new / no longer tracked objects, orbit changes, formations) unless --skip-changes
//   node dist/ssa-worker.js --once --day 2026-10-12 [--dry-run]
//                                           derive the changes of that UTC day only (no screening) and exit
//   node dist/ssa-worker.js --once --day 2026-10-12 --part coverage
//                                           build the star-map coverage files of that UTC day only (SSA_COVERAGE_DIR) and exit
// ============================================================

/** Element sets from the app's current-GP cache (data/tle-cache.json): used only while omm_updates is still empty. */
function fallback() {
  const cached = readCache();
  return cached ? cached.map(fromEnriched) : [];
}

async function runOnce(extra: Partial<NightlyOpts> = {}): Promise<NightlyResult> {
  await initHistory(); // migrations are idempotent; the api process normally did this already
  return runNightly({ fallback, ...extra });
}

/** Parts of the job: coverage is on unless SSA_COVERAGE=0. */
async function jobParts() {
  const parts: NonNullable<Parameters<typeof runJob>[1]> = { screen: { fallback }, ...(coverageEnabled() ? { coverage: coverageJobPart() } : {}) };
  return parts;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!isHistoryEnabled()) {
    logger.warn('SSA worker: DATABASE_URL is not set; nothing to do.');
    return;
  }

  if (process.argv.includes('--once')) {
    if (process.argv.includes('--catch-up')) {
      await initHistory();
      const rep = await runJob(getPool()!, await jobParts());
      console.log(JSON.stringify(rep));
      await closeHistory();
      process.exitCode = rep.locked ? 0 : 2;
      return;
    }
    const day = arg('day');
    if (day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day + 'T00:00:00Z'))) throw new Error(`--day: expected YYYY-MM-DD, got '${day}'`);
      await initHistory();
      const dry = process.argv.includes('--dry-run');
      const part = arg('part') ?? 'changes';
      if (part !== 'changes' && part !== 'coverage') throw new Error(`--part: expected changes or coverage, got '${part}'`);
      const l = await withJobLock(getPool()!, async () => (part === 'coverage' ? runCoverageDay(getPool()!, day) : runChanges(day, { dryRun: dry })));
      if (!l.locked) { logger.error('SSA worker: another process is running the job (advisory lock held); try again later'); process.exitCode = 2; }
      else console.log(JSON.stringify(l.value));
      await closeHistory();
      return;
    }
    const bt = arg('batch-time');
    const batchTimeMs = bt ? Date.parse(bt) : undefined;
    if (bt && !Number.isFinite(batchTimeMs)) throw new Error(`--batch-time: cannot parse '${bt}'`);
    const hours = arg('hours');
    const r = await runOnce({
      ...(batchTimeMs !== undefined ? { batchTimeMs } : {}),
      ...(hours ? { hours: Number(hours) } : {}),
      ...(process.argv.includes('--dry-run') ? { dryRun: true } : {}),
      ...(process.argv.includes('--skip-changes') ? { skipChanges: true } : {}),
    });
    console.log(JSON.stringify(r));
    await closeHistory();
    return;
  }

  // catch-up pass: at start-up and on every tick. `running` skips a tick while a pass is still going in this process; the advisory
  // lock (inside runJob) does the same across processes.
  let running = false;
  const tick = (why: string): void => {
    if (running) { logger.warn(`SSA worker: the previous pass is still going; skipping the ${why} pass`); return; }
    running = true;
    void (async () => {
      try {
        await initHistory();
        await runJob(getPool()!, await jobParts());
      } catch (err) {
        logger.error('SSA job failed (non-fatal):', (err as Error).message);
      } finally {
        running = false;
      }
    })();
  };
  const job = cron.schedule(SSA_CRON, () => tick('scheduled'), { timezone: 'UTC' });
  job.start();
  logger.info(`SSA worker scheduled: ${SSA_CRON} UTC (catch-up over the last ${process.env.SSA_BACKFILL_DAYS ?? 30} days at start-up and on every tick)`);
  tick('start-up');

  const stop = (signal: NodeJS.Signals): void => {
    logger.info(`Received ${signal}; stopping SSA worker`);
    job.stop();
    void closeHistory().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(async (err) => {
  logger.error('SSA worker failed:', (err as Error).message);
  await closeHistory();
  process.exitCode = 1;
});
