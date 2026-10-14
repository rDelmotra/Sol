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
import {
  DsoEphemerisEndedError,
  getDsoProviderAdapter,
  type DsoProviderAdapter,
} from '../providers/index.js';
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
import { clearDsoEnded, markDsoEnded, readDsoEndedState } from './ended-state.js';
import { dsoRetryEnded } from '../../utils/config.js';
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

/** Per-process memory, so "once per boot" really means once per boot. */
export interface DsoWorkerRuntime {
  /** Ended objects whose "keeping stored data" line was already logged. */
  loggedEnded: Set<string>;
  /** Ended objects already retried under DSO_RETRY_ENDED=1. */
  forcedRetried: Set<string>;
}

export function createDsoWorkerRuntime(): DsoWorkerRuntime {
  return { loggedEnded: new Set(), forcedRetried: new Set() };
}

const processRuntime = createDsoWorkerRuntime();

/** Everything reconcileDsoWorkerOnce can have injected (tests); production uses the defaults. */
export interface DsoReconcileDeps {
  entries?: readonly DsoRegistryEntry[];
  getProvider?: (provider: DsoRegistryEntry['provider']) => DsoProviderAdapter;
  runtime?: DsoWorkerRuntime;
  /** Overrides DSO_RETRY_ENDED. */
  retryEnded?: boolean;
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
  endedIds: ReadonlySet<string>,
): number | null {
  if (!manifest) {
    return null;
  }

  let minDelayMs = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    // An ended object is not retried, so it must not shorten the sleep.
    if (endedIds.has(entry.dsoId)) {
      continue;
    }
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

export function computeLoopDelayMs(
  entries: readonly DsoRegistryEntry[],
  manifest: DsoManifest | null,
  now: Date = new Date(),
  endedIds: ReadonlySet<string> = new Set(),
): number {
  const unavailableRetryDelayMs = computeNextUnavailableRetryDelayMs(entries, manifest, now, endedIds);
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
  provider: DsoProviderAdapter,
  wasEnded: boolean,
  runtime: DsoWorkerRuntime,
): Promise<DsoManifest> {
  const startedAt = Date.now();
  const now = new Date();
  const { windowStart, windowEnd } = computeWindow(entry, now);

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

    await settleEndedState(entry, providerFetch.coverageEndedAt ?? null, wasEnded, runtime);

    return manifest;
  } catch (error) {
    if (error instanceof DsoEphemerisEndedError) {
      // Not a failure: the provider has no more data for this mission. Remember
      // that, leave the stored ephemeris and the manifest exactly as they are, and
      // stop asking. If the flag cannot be saved, fall through to the normal
      // failure path so nothing is silently lost.
      try {
        await markDsoEnded(entry.dsoId, error.endedAt, new Date());
        runtime.loggedEnded.add(entry.dsoId); // this is the boot's one line for the object
        logger.info(
          `DSO ephemeris ended ${error.endedAt.toISOString()}, keeping stored data: dsoId=${entry.dsoId} provider=${entry.provider} (no more refresh attempts; DSO_RETRY_ENDED=1 forces a retry)`,
        );
        return currentManifest;
      } catch (markError) {
        logger.warn(
          `DSO ended-state could not be saved (${formatErrorMessage(markError)}) — recording a normal failure instead`,
        );
      }
    }

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

/**
 * After a successful publish: the provider says the data ends in the past ->
 * remember it (this was the last useful fetch); it says nothing and the object
 * was marked ended -> new data appeared, clear the flag. Never throws: the
 * snapshot is already published.
 */
async function settleEndedState(
  entry: DsoRegistryEntry,
  coverageEndedAt: string | null,
  wasEnded: boolean,
  runtime: DsoWorkerRuntime,
): Promise<void> {
  try {
    if (coverageEndedAt) {
      await markDsoEnded(entry.dsoId, coverageEndedAt, new Date());
      runtime.loggedEnded.add(entry.dsoId); // this is the boot's one line for the object
      logger.info(
        `DSO ephemeris ended ${coverageEndedAt}, final snapshot published: dsoId=${entry.dsoId} (no more refresh attempts; stored data stays; DSO_RETRY_ENDED=1 forces a retry)`,
      );
    } else if (wasEnded) {
      await clearDsoEnded(entry.dsoId);
      logger.info(`DSO new ephemeris data found, ended flag cleared: dsoId=${entry.dsoId}`);
    }
  } catch (error) {
    logger.warn(`DSO ended-state could not be updated (${formatErrorMessage(error)}) — snapshot already published`);
  }
}

export async function reconcileDsoWorkerOnce(
  now: Date = new Date(),
  deps: DsoReconcileDeps = {},
): Promise<DsoManifest> {
  const enabledEntries = deps.entries ?? getEnabledDsoRegistryEntries();
  const getProvider = deps.getProvider ?? getDsoProviderAdapter;
  const runtime = deps.runtime ?? processRuntime;
  const retryEnded = deps.retryEnded ?? dsoRetryEnded();
  const workerLastRunAt = now.toISOString();

  let manifest = (await readDsoManifest()) ?? null;
  ({ manifest } = await publishDsoWorkerHeartbeat(manifest, workerLastRunAt));
  const endedState = await readDsoEndedState();

  for (const entry of enabledEntries) {
    const ended = endedState.objects[entry.dsoId];

    if (ended) {
      // A finished mission: serve what is stored, do not ask the provider again.
      // DSO_RETRY_ENDED=1 allows one retry per object per boot.
      if (!retryEnded || runtime.forcedRetried.has(entry.dsoId)) {
        if (!runtime.loggedEnded.has(entry.dsoId)) {
          runtime.loggedEnded.add(entry.dsoId);
          logger.info(
            `DSO ephemeris ended ${ended.endedAt}, keeping stored data: dsoId=${entry.dsoId} (DSO_RETRY_ENDED=1 forces a retry)`,
          );
        }
        continue;
      }
      runtime.forcedRetried.add(entry.dsoId);
      logger.info(`DSO_RETRY_ENDED is set: retrying ended object once: dsoId=${entry.dsoId}`);
    } else if (!shouldRefreshDsoEntry(entry, manifest.objects[entry.dsoId], now)) {
      continue;
    }

    manifest = await refreshDsoEntry(entry, manifest, workerLastRunAt, getProvider(entry.provider), Boolean(ended), runtime);
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
      const endedIds = new Set(Object.keys((await readDsoEndedState()).objects));
      const delayMs = computeLoopDelayMs(activeEntries, latestManifest, new Date(), endedIds);
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
