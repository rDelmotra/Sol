import 'dotenv/config';
import cron from 'node-cron';
import { readCache } from './cache/file-cache.js';
import { closeHistory, initHistory, isHistoryEnabled } from './history/index.js';
import { fromEnriched, runChanges, runNightly, SSA_CRON, type NightlyOpts, type NightlyResult } from './ssa/index.js';
import { logger } from './utils/logger.js';

// ============================================================
// SSA worker — the nightly encounter screening, as a supervisor child (non-critical, only spawned when DATABASE_URL is set).
//
//   node dist/ssa-worker.js                 schedule runNightly at 02:30 UTC (the 02:00 ingest has filled omm_updates by then)
//   node dist/ssa-worker.js --once [--batch-time 2026-10-12T12:00:00Z] [--hours 36] [--dry-run] [--skip-changes]
//                                           run one screening now and exit (0 = ok); it first derives the previous UTC day's changes
//                                           (new / no longer tracked objects, orbit changes, formations) unless --skip-changes
//   node dist/ssa-worker.js --once --day 2026-10-12 [--dry-run]
//                                           derive the changes of that UTC day only (no screening) and exit
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
    const day = arg('day');
    if (day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day + 'T00:00:00Z'))) throw new Error(`--day: expected YYYY-MM-DD, got '${day}'`);
      await initHistory();
      console.log(JSON.stringify(await runChanges(day, { dryRun: process.argv.includes('--dry-run') })));
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

  let running = false;
  const job = cron.schedule(SSA_CRON, () => {
    if (running) { logger.warn('SSA worker: the previous run is still going; skipping this one'); return; }
    running = true;
    runOnce()
      .catch((err) => logger.error('SSA nightly run failed (non-fatal):', (err as Error).message))
      .finally(() => { running = false; });
  }, { timezone: 'UTC' });
  job.start();
  logger.info(`SSA worker scheduled: ${SSA_CRON} UTC`);

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
