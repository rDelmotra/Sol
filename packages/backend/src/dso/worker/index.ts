/**
 * DSO worker scaffold.
 *
 * Owns:
 * - orchestration of DSO refresh and reconciliation loops
 * - worker lifecycle boundaries for asynchronous DSO ingestion
 *
 * Does not own:
 * - HTTP route definitions
 * - API payload shaping
 * - provider-specific parsing details
 * - imports from TLE-specific types or updater logic
 *
 * Filled in by:
 * - a later phase that adds the DSO worker entrypoint and reconcile logic
 */
import { setTimeout } from 'node:timers/promises';
import type { DsoManifest } from '@orbitwatch/contracts';
import { convertProviderFetchToDsoSnapshot, validateDsoSnapshot } from '../normalize/index.js';
import {
  getEnabledDsoRegistryEntries,
  type DsoRegistryEntry,
} from '../registry/index.js';
import { getDsoProviderAdapter } from '../providers/index.js';
import {
  getUnavailableRetryDelayMs,
  shouldRefreshDsoEntry,
} from './retry-policy.js';
import {
  publishDsoFailureState,
  publishDsoSnapshot,
  publishDsoWorkerHeartbeat,
  readDsoManifest,
} from '../snapshot/index.js';
import { logger } from '../../utils/logger.js';

const FALLBACK_LOOP_INTERVAL_MS = 60_000;
const LOOP_JITTER_RATIO = 0.1;
const MIN_LOOP_INTERVAL_MS = 1_000;

export interface DsoWorkerLoopOptions {
  sleep?: (ms: number, options?: { signal?: AbortSignal }) => Promise<void>;
  onIterationError?: (error: unknown) => void;
}

export interface DsoWorkerControls {
  stop: () => void;
  run: Promise<void>;
}

function computeWindow(entry: DsoRegistryEntry, now: Date): { windowStart: Date; windowEnd: Date } {
  let windowStartMs = now.getTime() - entry.validPastWindowSec * 1000;

  if (entry.launchDate) {
    const launchDateMs = new Date(entry.launchDate).getTime();
    if (Number.isFinite(launchDateMs) && windowStartMs < launchDateMs) {
      windowStartMs = launchDateMs;
    }
  }

  return {
    windowStart: new Date(windowStartMs),
    windowEnd: new Date(now.getTime() + entry.validFutureWindowSec * 1000),
  };
}

function computeNextUnavailableRetryDelayMs(
  entries: readonly DsoRegistryEntry[],
  manifest: DsoManifest | null,
  now: Date,
): number | null {
  if (!manifest) {
    return null;
  }

  let minDelayMs = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    const status = manifest.objects[entry.dsoId];
    if (!status?.lastFailureAt || status.currentSnapshotVersion) {
      continue;
    }

    const unavailableRetryDelayMs = getUnavailableRetryDelayMs(status, now);
    if (unavailableRetryDelayMs === null) {
      continue;
    }
    if (!Number.isFinite(unavailableRetryDelayMs)) {
      minDelayMs = Math.min(minDelayMs, MIN_LOOP_INTERVAL_MS);
      continue;
    }

    const delayMs = Math.max(MIN_LOOP_INTERVAL_MS, unavailableRetryDelayMs);
    minDelayMs = Math.min(minDelayMs, delayMs);
  }

  return Number.isFinite(minDelayMs) ? minDelayMs : null;
}

function computeLoopDelayMs(
  entries: readonly DsoRegistryEntry[],
  manifest: DsoManifest | null,
  now: Date = new Date(),
): number {
  const unavailableRetryDelayMs = computeNextUnavailableRetryDelayMs(entries, manifest, now);
  if (unavailableRetryDelayMs !== null) {
    return unavailableRetryDelayMs;
  }

  const shortestRefreshMs = entries.reduce<number>(
    (shortest, entry) => Math.min(shortest, entry.refreshIntervalSec * 1000),
    Number.POSITIVE_INFINITY,
  );

  const baseMs = Number.isFinite(shortestRefreshMs) ? shortestRefreshMs : FALLBACK_LOOP_INTERVAL_MS;
  const jitterFraction = (Math.random() * 2 - 1) * LOOP_JITTER_RATIO;
  return Math.max(MIN_LOOP_INTERVAL_MS, Math.round(baseMs * (1 + jitterFraction)));
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshDsoEntry(
  entry: DsoRegistryEntry,
  currentManifest: DsoManifest,
  workerLastRunAt: string,
): Promise<DsoManifest> {
  const startedAt = Date.now();
  const now = new Date();
  const { windowStart, windowEnd } = computeWindow(entry, now);
  const provider = getDsoProviderAdapter(entry.provider);

  logger.info(
    `DSO refresh starting: dsoId=${entry.dsoId} provider=${entry.provider} windowStart=${windowStart.toISOString()} windowEnd=${windowEnd.toISOString()}`,
  );

  try {
    const providerFetch = await provider.fetchEphemeris(entry, windowStart, windowEnd);
    const snapshot = convertProviderFetchToDsoSnapshot(entry, providerFetch, windowStart, windowEnd);
    validateDsoSnapshot(snapshot);

    const { manifest } = await publishDsoSnapshot(entry, snapshot, currentManifest, workerLastRunAt);
    const durationMs = Date.now() - startedAt;

    logger.info(
      `DSO refresh succeeded: dsoId=${entry.dsoId} provider=${entry.provider} durationMs=${durationMs} snapshotVersion=${snapshot.snapshotVersion}`,
    );

    return manifest;
  } catch (error) {
    const failureAt = new Date().toISOString();
    const { manifest } = await publishDsoFailureState(
      entry,
      currentManifest,
      failureAt,
      workerLastRunAt,
    );
    const durationMs = Date.now() - startedAt;

    logger.error(
      `DSO refresh failed: dsoId=${entry.dsoId} provider=${entry.provider} durationMs=${durationMs} error=${formatErrorMessage(error)}`,
    );

    return manifest;
  }
}

export async function reconcileDsoWorkerOnce(
  now: Date = new Date(),
): Promise<DsoManifest> {
  const enabledEntries = getEnabledDsoRegistryEntries();
  const workerLastRunAt = now.toISOString();

  let manifest = (await readDsoManifest()) ?? null;
  ({ manifest } = await publishDsoWorkerHeartbeat(manifest, workerLastRunAt));

  for (const entry of enabledEntries) {
    const status = manifest.objects[entry.dsoId];
    if (!shouldRefreshDsoEntry(entry, status, now)) {
      continue;
    }

    manifest = await refreshDsoEntry(entry, manifest, workerLastRunAt);
  }

  return manifest;
}

export function startDsoWorkerLoop(options: DsoWorkerLoopOptions = {}): DsoWorkerControls {
  const delaySleep = options.sleep ?? setTimeout;
  const abortController = new AbortController();
  let stopRequested = false;
  let latestManifest: DsoManifest | null = null;

  const run = (async () => {
    const initialEntries = getEnabledDsoRegistryEntries();
    logger.info(
      `DSO worker starting with ${initialEntries.length} enabled object(s): ${initialEntries.map((entry) => entry.dsoId).join(', ') || 'none'}`,
    );

    while (!stopRequested) {
      try {
        latestManifest = await reconcileDsoWorkerOnce();
      } catch (error) {
        logger.error(`DSO worker iteration crashed: ${formatErrorMessage(error)}`);
        options.onIterationError?.(error);
      }

      if (stopRequested) {
        break;
      }

      const activeEntries = getEnabledDsoRegistryEntries();
      const delayMs = computeLoopDelayMs(activeEntries, latestManifest, new Date());
      logger.info(`DSO worker sleeping for ${delayMs}ms before next reconcile`);

      try {
        await delaySleep(delayMs, { signal: abortController.signal });
      } catch (err: any) {
        if (err.name === 'AbortError') {
          break;
        }
        throw err;
      }
    }

    logger.info('DSO worker stopped');
  })();

  return {
    stop: () => {
      stopRequested = true;
      abortController.abort();
    },
    run,
  };
}

export { shouldRefreshDsoEntry } from './retry-policy.js';
