import { isCacheFresh, readVersion, readCache } from './cache/file-cache.js';
import { primeTlePayload } from './cache/tle-payload-cache.js';
import { loadEnrichment, getDecayedCatalog } from './enrichment/store.js';
import { getAnalyticRegistry } from './analytic/index.js';
import { scheduleTLEUpdater } from './cron/tle-updater.js';
import {
  initHistory,
  ingestCurrentGp,
  isHistoryEnabled,
  isHistoryReady,
} from './history/index.js';
import { logger } from './utils/logger.js';
import { reportDiskAndAlert } from './utils/volume-alert.js';

export interface BootStep {
  name: string;
  run: () => void | Promise<void>;
}

/** How long the boot disk report may take before it is given up on. */
export const DISK_REPORT_TIMEOUT_MS = 5_000;

/**
 * Start the disk usage report and return a promise that NEVER rejects and settles
 * within `timeoutMs` at the latest, even when the filesystem call hangs. The boot
 * step does not wait for it. It logs, and sends one volume alert per UTC day and level
 * at >= 75% / >= 90% (not awaited: only the statfs is inside the guard). It never deletes.
 */
export function startDiskReport(
  logDisk: () => Promise<unknown> = () => reportDiskAndAlert('boot'),
  timeoutMs: number = DISK_REPORT_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn(`Disk usage check (boot) did not finish in ${timeoutMs} ms — giving up on it`);
      resolve();
    }, timeoutMs);
    timer.unref();

    let work: Promise<unknown>;
    try {
      work = Promise.resolve(logDisk());
    } catch (err) {
      work = Promise.reject(err);
    }
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        logger.warn(`Disk usage check (boot) failed: ${(err as Error)?.message ?? String(err)}`);
        resolve();
      },
    );
  });
}

/**
 * The disk report as a boot step: fire and forget. It returns at once, so a hung
 * statfs can never delay the steps around it (above all the TLE updater).
 */
export function makeDiskReportStep(
  logDisk?: () => Promise<unknown>,
  timeoutMs?: number,
): BootStep {
  return {
    name: 'disk-usage',
    run() {
      void startDiskReport(logDisk, timeoutMs);
    },
  };
}

const reportDisk: BootStep = makeDiskReportStep();

const warmEnrichment: BootStep = {
  name: 'enrichment',
  run() {
    // Warm the in-memory enrichment store so the daily join + the metadata/catalog
    // routes don't pay the one-time disk read on first use. Degrades gracefully
    // (empty) if the build artifact is missing — the TLE/DSO backend is untouched.
    loadEnrichment();
    getDecayedCatalog();
  },
};

const initHistoryDb: BootStep = {
  name: 'history-init',
  async run() {
    // Optional history DB: migrate + (best-effort) Timescale upgrade BEFORE the
    // updater runs, so the first ingest sees a ready schema. Any failure is
    // non-fatal — the TLE/DSO backend is untouched and /api/history/* 503s.
    if (isHistoryEnabled()) {
      try {
        await initHistory();
        logger.info('History DB ready (migrations applied)');
      } catch (err) {
        logger.error('History DB init failed (non-fatal — history disabled):', (err as Error).message);
      }
    }
  },
};

const tleFreshness: BootStep = {
  name: 'tle-freshness',
  run() {
    // If the cache is missing or older than the 24h TTL, kick off an immediate fetch.
    // The cron job is always scheduled so subsequent refreshes happen daily at 02:00 UTC.
    const needsImmediateFetch = !isCacheFresh();
    scheduleTLEUpdater(needsImmediateFetch);

    if (!needsImmediateFetch) {
      const version = readVersion();
      logger.info(`Serving cached data: ${version?.count} objects, version=${version?.version}`);
      // Cache is fresh at boot — warm the in-memory gzipped payload now so the
      // first /api/tle/all request doesn't pay the one-time rebuild. (The
      // immediate-fetch path warms via the cron updater after writeCache.)
      primeTlePayload();

      // Seed today's history from the already-fresh cache so accumulation starts
      // immediately even when no fetch runs this boot. Idempotent (ON CONFLICT
      // keeps the latest epoch) and non-fatal. The immediate-fetch path instead
      // ingests via the cron hook after writeCache.
      if (isHistoryReady()) {
        const cached = readCache();
        if (cached) {
          ingestCurrentGp(cached, null, 'cache').catch((err) =>
            logger.error('History boot-seed failed (non-fatal):', (err as Error).message),
          );
        }
      }
    }
  },
};

const analyticSnapshot: BootStep = {
  name: 'analytic-registry',
  run() {
    // P3 S2: measure the analytic server-executor's capability+coverage at boot.
    // /api/query/ask (routes/query.ts) executes against this registry; measuring
    // it here is cheap and surfaces artifact/provider problems at boot instead
    // of first-query.
    try {
      const snapshot = getAnalyticRegistry().snapshot();
      for (const u of snapshot.universes) {
        logger.info(`analytic[${u.universe}]: ${u.spineSize.toLocaleString()} objects, ${u.fields.length} fields measured`);
      }
    } catch (err) {
      logger.error('Analytic registry snapshot failed (non-fatal):', (err as Error).message);
    }
  },
};

// The disk report runs LAST and is not awaited: nothing may wait on the filesystem
// before the TLE updater is scheduled.
export const BOOT_STEPS: readonly BootStep[] = [
  warmEnrichment,
  initHistoryDb,
  tleFreshness,
  analyticSnapshot,
  reportDisk,
];

/** Runs the startup steps in order. No error handling here: a throw propagates. */
export async function runBootTasks(steps: readonly BootStep[] = BOOT_STEPS): Promise<void> {
  for (const step of steps) await step.run();
}
