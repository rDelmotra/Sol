import type { DsoObjectStatus } from '@orbitwatch/contracts';
import type { DsoRegistryEntry } from '../registry/types.js';

const UNAVAILABLE_BACKOFF_BASE_MS = 60_000;
const UNAVAILABLE_BACKOFF_MAX_MS = 30 * 60_000;

function parseIsoTimestamp(value: string | null): number {
  if (!value) {
    return Number.NaN;
  }
  return Date.parse(value);
}

export function computeUnavailableBackoffMs(failureCount: number): number {
  const exponent = Math.max(0, Math.min(10, failureCount - 1));
  return Math.min(UNAVAILABLE_BACKOFF_MAX_MS, UNAVAILABLE_BACKOFF_BASE_MS * 2 ** exponent);
}

export function getUnavailableRetryDelayMs(
  status: DsoObjectStatus | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!status?.lastFailureAt || status.currentSnapshotVersion) {
    return null;
  }

  const lastFailureMs = parseIsoTimestamp(status.lastFailureAt);
  if (!Number.isFinite(lastFailureMs)) {
    return 0;
  }

  const retryAtMs = lastFailureMs + computeUnavailableBackoffMs(status.failureCount);
  return Math.max(0, retryAtMs - now.getTime());
}

export function shouldRefreshDsoEntry(
  entry: DsoRegistryEntry,
  status: DsoObjectStatus | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!entry.enabled) {
    return false;
  }

  if (!status?.currentSnapshotVersion || !status.lastSuccessAt) {
    const unavailableRetryDelayMs = getUnavailableRetryDelayMs(status, now);
    return unavailableRetryDelayMs === null || unavailableRetryDelayMs <= 0;
  }

  const nowMs = now.getTime();
  const lastSuccessMs = parseIsoTimestamp(status.lastSuccessAt);
  const validToMs = parseIsoTimestamp(status.validTo);
  const refreshIntervalMs = entry.refreshIntervalSec * 1000;

  if (!Number.isFinite(lastSuccessMs)) {
    return true;
  }

  if (nowMs - lastSuccessMs >= refreshIntervalMs) {
    return true;
  }

  if (!Number.isFinite(validToMs)) {
    return true;
  }

  return validToMs - nowMs <= refreshIntervalMs;
}
