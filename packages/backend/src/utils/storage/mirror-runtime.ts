import path from 'node:path';
import { logger } from '../logger.js';
import { bucketConfig, storageBackend } from '../config.js';
import { cacheDir, historyArchiveDir } from '../paths.js';
import { createBlobStore } from './index.js';
import { Mirror, type MirrorSpec } from './mirror.js';

// ============================================================
// The process-wide mirror: which files it covers, when it is on, and the hooks the
// rest of the backend calls (boot step, state-file writes, shutdown).
//
// On only when STORAGE_BACKEND=s3 AND the bucket variables are complete. Otherwise
// every function here is a no-op and the backend behaves exactly as it always did.
// ============================================================

/** Interval of the background flush. Writes of the small state files flush sooner (requestMirrorFlush). */
export const MIRROR_FLUSH_INTERVAL_MS = 10_000;

/** The catalog is listed before its version marker so a reader never sees a version without its data. */
export function mirrorSpec(): MirrorSpec {
  const root = cacheDir();
  const archive = historyArchiveDir();
  const defaultArchive = path.join(root, 'history', 'raw');
  return {
    files: [
      'tle-cache.json',
      'version.json',
      'visual-cache.json',
      'swpc-cache.json',
      'gazetteer-cache.json',
      'spacetrack-attempts.json',
      'celestrak-attempts.json',
      'alert-state.json',
    ],
    dirs: ['dso'],
    // A HISTORY_ARCHIVE_DIR outside CACHE_DIR is not mirrored (its keys would not be relative to the root).
    archiveDirs: path.resolve(archive) === path.resolve(defaultArchive) ? ['history/raw'] : [],
  };
}

let current: Mirror | null = null;

/** The mirror for this process, created on first call; null when mirroring is off. */
export function initMirror(): Mirror | null {
  if (current) return current;
  if (storageBackend() !== 's3' || !bucketConfig()) return null;
  const remote = createBlobStore({ fileRoot: cacheDir() });
  if (remote.kind !== 's3') return null;
  current = new Mirror(cacheDir(), remote, mirrorSpec());
  return current;
}

export function getMirror(): Mirror | null {
  return current;
}

/** Called after a small state file is written. A no-op unless the mirror is running. */
export function requestMirrorFlush(): void {
  current?.requestFlush();
}

/**
 * API process boot: reconcile with the bucket (bounded by `timeoutMs`), then keep it flushed.
 * Never throws: on any failure the backend carries on with the local files.
 */
export async function startMirror(timeoutMs = 120_000): Promise<void> {
  const mirror = initMirror();
  if (!mirror) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      mirror.syncAtBoot(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`Storage mirror: boot sync did not finish in ${timeoutMs} ms — carrying on with the local files`);
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    logger.warn(`Storage mirror: boot sync failed (${(err as Error).message}) — carrying on with the local files`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  mirror.start(MIRROR_FLUSH_INTERVAL_MS);
}

/** DSO worker boot: pull the dso/ folder from the bucket if this disk is missing it. Never throws. */
export async function hydrateDsoOnly(timeoutMs = 60_000): Promise<void> {
  const root = cacheDir();
  if (storageBackend() !== 's3' || !bucketConfig()) return;
  const remote = createBlobStore({ fileRoot: root });
  if (remote.kind !== 's3') return;
  const mirror = new Mirror(root, remote, { files: [], dirs: ['dso'], archiveDirs: [] });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      mirror.syncAtBoot().then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch (err) {
    logger.warn(`Storage mirror: DSO hydration failed (${(err as Error).message})`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * On SIGTERM/SIGINT, flush once more (up to `timeoutMs`) and then exit like the default
 * handler would. Registered only when the mirror is running, so with mirroring off the
 * process keeps Node's default signal behaviour.
 */
export function installMirrorShutdown(timeoutMs = 8_000): void {
  const mirror = current;
  if (!mirror) return;
  let closing = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    logger.info(`Received ${signal}; flushing the storage mirror before exit`);
    void mirror.close(timeoutMs).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
}

/** Test helper: forget the process-wide mirror. */
export function resetMirrorForTests(): void {
  current = null;
}
