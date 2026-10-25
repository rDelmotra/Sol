import { isCacheFresh, readVersion, readCache } from './cache/file-cache.js';
import { primeTlePayload } from './cache/tle-payload-cache.js';
import { loadEnrichment, getDecayedCatalog } from './enrichment/store.js';
import { getAnalyticRegistry } from './analytic/index.js';
import { runUpdateCycle, scheduleTLEUpdater } from './cron/tle-updater.js';
import {
  initHistory,
  ingestCurrentGp,
  isHistoryEnabled,
  isHistoryReady,
} from './history/index.js';
import { logger } from './utils/logger.js';
import {
  installMirrorShutdown,
  mirrorBootIncomplete,
  retryMirrorBoot,
  startMirror,
} from './utils/storage/mirror-runtime.js';
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

/**
 * First step: with STORAGE_BACKEND=s3 and a bucket configured, reconcile the cache
 * directory with the bucket BEFORE anything reads it (the freshness check below reads
 * the catalog's mtime), then keep it flushed. A no-op otherwise. Never throws.
 */
export const storageSync: BootStep = {
  name: 'storage-sync',
  async run() {
    await startMirror();
    installMirrorShutdown();
  },
};

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

export type BootFetchDecision = 'serve-cache' | 'fetch' | 'wait-for-bucket';

/**
 * Pure policy for the boot-time Space-Track fetch.
 *  - cache fresh                         -> serve it, no fetch
 *  - stale/missing, bucket state intact  -> fetch now (as always)
 *  - stale/missing, bucket not readable  -> wait: the attempt log and catalog that the bucket
 *    holds were not restored, so a fetch now would run with the daily counter at zero
 */
export function decideBootFetch(cacheFresh: boolean, mirrorIncomplete: boolean): BootFetchDecision {
  if (cacheFresh) return 'serve-cache';
  return mirrorIncomplete ? 'wait-for-bucket' : 'fetch';
}

/** How long to wait before looking at the bucket again, and how many times before giving up. */
export const MIRROR_RECOVERY_DELAY_MS = 15 * 60_000;
export const MIRROR_RECOVERY_MAX_ATTEMPTS = 3;

export interface MirrorRecoveryDeps {
  delayMs: number;
  maxAttempts: number;
  /** Re-run the bucket sync; true when it now completes cleanly. */
  retry: () => Promise<boolean>;
  cacheFresh: () => boolean;
  fetchNow: () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
}

/**
 * After a boot where the bucket could not be read and the cache is stale: look at the bucket
 * again every `delayMs`. The first clean sync restores the real state (counters, catalog), then
 * the fetch runs only if the restored cache is still stale. After `maxAttempts` failed looks it
 * fetches anyway: an empty or stale site is worse than one extra call, and the attempt gate and
 * the 5-a-day cap still apply. The 02:00 cron is independent of all this.
 */
export function armMirrorRecovery(deps: MirrorRecoveryDeps, attempt = 1): void {
  deps.setTimer(() => {
    void (async () => {
      const ok = await deps.retry();
      if (ok) {
        logger.info('Storage mirror recovered after boot');
        if (!deps.cacheFresh()) deps.fetchNow();
        return;
      }
      if (attempt >= deps.maxAttempts) {
        logger.error(
          `Storage mirror still unreadable after ${attempt} more tries — fetching without restored state (the attempt gate and daily cap still apply)`,
        );
        if (!deps.cacheFresh()) deps.fetchNow();
        return;
      }
      armMirrorRecovery(deps, attempt + 1);
    })();
  }, deps.delayMs);
}

const tleFreshness: BootStep = {
  name: 'tle-freshness',
  run() {
    // If the cache is missing or older than the 24h TTL, kick off an immediate fetch.
    // The cron job is always scheduled so subsequent refreshes happen daily at 02:00 UTC.
    const decision = decideBootFetch(isCacheFresh(), mirrorBootIncomplete());
    if (decision === 'wait-for-bucket') {
      logger.warn(
        'Cache is stale and the bucket could not be read at boot — not fetching from Space-Track yet; ' +
          `checking the bucket again in ${MIRROR_RECOVERY_DELAY_MS / 60_000} min (the 02:00 cron still runs)`,
      );
      scheduleTLEUpdater(false);
      armMirrorRecovery({
        delayMs: MIRROR_RECOVERY_DELAY_MS,
        maxAttempts: MIRROR_RECOVERY_MAX_ATTEMPTS,
        retry: retryMirrorBoot,
        cacheFresh: isCacheFresh,
        fetchNow: () => void runUpdateCycle('boot').catch((err) => logger.error('Recovery fetch error:', err)),
        setTimer: (fn, ms) => {
          const t = setTimeout(fn, ms);
          t.unref();
          return t;
        },
      });
      return;
    }
    const needsImmediateFetch = decision === 'fetch';
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
  storageSync,
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
