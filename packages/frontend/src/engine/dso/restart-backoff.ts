/** First wait before the DSO worker is restarted after an error. */
export const DSO_WORKER_RESTART_BASE_MS = 500;
/** Longest wait between DSO worker restarts. A broken worker must not spin. */
export const DSO_WORKER_RESTART_MAX_MS = 5 * 60 * 1000;

/** A worker that has been up this long counts as healthy; a failure after that starts the backoff again. */
export const DSO_WORKER_STABLE_MS = 10_000;

/**
 * Delay to use after a message arrived from the worker: back to the base only when the
 * worker has been alive for DSO_WORKER_STABLE_MS. A worker that posts once and then
 * dies keeps its growing delay, so it cannot loop at the base delay forever.
 */
export function workerBackoffAfterMessage(currentMs: number, aliveMs: number): number {
  return aliveMs >= DSO_WORKER_STABLE_MS ? DSO_WORKER_RESTART_BASE_MS : currentMs;
}

/** Delay to use after `currentMs`: doubled, never above 5 minutes. */
export function nextWorkerRestartDelay(currentMs: number): number {
  return Math.min(Math.max(currentMs, DSO_WORKER_RESTART_BASE_MS) * 2, DSO_WORKER_RESTART_MAX_MS);
}
