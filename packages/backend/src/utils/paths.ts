import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Single home for backend filesystem path resolution. Anchored to this file's
// location (src/utils or dist/utils -> packages/backend), so paths are stable
// regardless of cwd and identical under tsx and compiled node.
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Every helper reads process.env WHEN CALLED, never at module load.

/** CACHE_DIR env override, else <backend>/data. */
export function cacheDir(): string {
  if (process.env.CACHE_DIR) return path.resolve(process.env.CACHE_DIR);
  return path.join(BACKEND_ROOT, 'data');
}

/** DSO snapshot cache root: <cacheDir>/dso. */
export function dsoCacheRoot(): string {
  return path.join(cacheDir(), 'dso');
}

/** HISTORY_ARCHIVE_DIR env override, else <cacheDir>/history/raw. */
export function historyArchiveDir(): string {
  if (process.env.HISTORY_ARCHIVE_DIR) return path.resolve(process.env.HISTORY_ARCHIVE_DIR);
  return path.join(cacheDir(), 'history', 'raw');
}

/** Always <backend>/data — deliberately IGNORES CACHE_DIR (the analytic compiler's existing behaviour). */
export function backendDataDir(): string {
  return path.join(BACKEND_ROOT, 'data');
}

/** Committed enrichment artifacts: <backend>/enrichment-data. */
export function enrichmentDataDir(): string {
  return path.join(BACKEND_ROOT, 'enrichment-data');
}

/** Built frontend assets: packages/frontend/dist. */
export function frontendDistDir(): string {
  return path.resolve(BACKEND_ROOT, '../frontend/dist');
}
