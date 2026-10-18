/** First wait before the DSO worker is restarted after an error. */
export const DSO_WORKER_RESTART_BASE_MS = 500;
/** Longest wait between DSO worker restarts. A broken worker must not spin. */
export const DSO_WORKER_RESTART_MAX_MS = 5 * 60 * 1000;

/** Delay to use after `currentMs`: doubled, never above 5 minutes. */
export function nextWorkerRestartDelay(currentMs: number): number {
  return Math.min(Math.max(currentMs, DSO_WORKER_RESTART_BASE_MS) * 2, DSO_WORKER_RESTART_MAX_MS);
}
