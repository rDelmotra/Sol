import { logger } from '../utils/logger.js';
import { gatedCelesTrakGet } from './celestrak-http.js';

// Same CelesTrak calling rules as the catalog fallback (services/celestrak.ts):
// no retry on a 4xx, retries only for timeouts, network errors and 5xx, and a
// persisted 2 hour gate (group 'visual' in celestrak-attempts.json). A skipped or
// failed refresh is an error to the route, which then serves the stale cache.
const CELESTRAK_VISUAL_GROUP = 'visual';
const CELESTRAK_VISUAL_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=json';

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 2_000;

type CelesTrakVisualRow = {
  NORAD_CAT_ID?: number | string;
};

function normalizeNoradIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    throw new Error('CelesTrak visual response is not an array');
  }

  const ids = new Set<number>();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;

    const maybeId = (row as CelesTrakVisualRow).NORAD_CAT_ID;
    const parsed =
      typeof maybeId === 'number'
        ? maybeId
        : typeof maybeId === 'string'
          ? Number(maybeId)
          : Number.NaN;

    if (Number.isInteger(parsed) && parsed > 0) {
      ids.add(parsed);
    }
  }

  const deduped = Array.from(ids).sort((a, b) => a - b);
  if (deduped.length === 0) {
    throw new Error('CelesTrak visual response contained no NORAD IDs');
  }

  return deduped;
}

export async function fetchCelesTrakVisualNoradIds(now: () => number = Date.now): Promise<number[]> {
  const data = await gatedCelesTrakGet<unknown>(
    CELESTRAK_VISUAL_GROUP,
    CELESTRAK_VISUAL_URL,
    { label: 'CelesTrak visual', timeoutMs: REQUEST_TIMEOUT_MS, retryCount: RETRY_COUNT, retryDelayMs: RETRY_DELAY_MS },
    now,
  );
  const ids = normalizeNoradIds(data);
  logger.info(`CelesTrak visual: received ${ids.length} NORAD IDs`);
  return ids;
}
