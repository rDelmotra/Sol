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

export interface BootStep {
  name: string;
  run: () => void | Promise<void>;
}

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

export const BOOT_STEPS: readonly BootStep[] = [
  warmEnrichment,
  initHistoryDb,
  tleFreshness,
  analyticSnapshot,
];

/** Runs the startup steps in order. No error handling here: a throw propagates. */
export async function runBootTasks(steps: readonly BootStep[] = BOOT_STEPS): Promise<void> {
  for (const step of steps) await step.run();
}
