import { CelesTrakGPElement } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { gatedCelesTrakGet } from './celestrak-http.js';

// CelesTrak's public GP element set endpoint — no auth required.
//
// GROUP=active is the ~16.7k active satellites, in JSON. JSON is required: catalog
// numbers of 100000 and up (issued since 2026-07-11) cannot be written in TLE format.
// It is NOT the full catalog (no debris, no rocket bodies, no decayed objects), and
// neither is any other CelesTrak group. The old `last-30-days` group is only the
// RECENT LAUNCHES (hundreds of objects). So this is a fallback that is OVERLAID on the
// cached catalog (see cache/catalog-overlay.ts), never a replacement for it.
export const CELESTRAK_FALLBACK_GROUP = 'active';
const CELESTRAK_URL = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${CELESTRAK_FALLBACK_GROUP}&FORMAT=json`;

const REQUEST_TIMEOUT_MS = 30_000; // 30 s — CelesTrak can be slow under load
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 5_000; // 5 s between retries; CelesTrak sends 503 during updates

/**
 * Fetch raw GP array. Retries only timeouts, network errors and 5xx (max 3 tries).
 * Any 4xx (403 "not updated since your last download", 404) throws at once. The
 * whole thing sits behind the persisted 2 hour gate: when it is closed this throws
 * CelesTrakSkippedError without a request.
 */
async function fetchRaw(now: () => number): Promise<CelesTrakGPElement[]> {
  const data = await gatedCelesTrakGet<CelesTrakGPElement[]>(
    CELESTRAK_FALLBACK_GROUP,
    CELESTRAK_URL,
    { label: 'CelesTrak', timeoutMs: REQUEST_TIMEOUT_MS, retryCount: RETRY_COUNT, retryDelayMs: RETRY_DELAY_MS },
    now,
  );
  if (!Array.isArray(data)) {
    throw new Error('CelesTrak: unexpected non-array response');
  }
  logger.info(`CelesTrak: received ${data.length} elements`);
  return data;
}

/**
 * Fetch, filter, and deduplicate the active-satellite GP set from CelesTrak.
 *
 * 1. Fetch from CelesTrak (gated to once per 2 hours, no retry on 4xx).
 * 2. Drop objects with a DECAY_DATE — they have re-entered; their TLEs are
 *    stale and their positions would be nonsensical.
 * 3. Deduplicate by NORAD_CAT_ID, keeping the entry with the newest EPOCH.
 *    (The API should not return duplicates, but this is defensive.)
 *
 * NORAD_CAT_ID stays a plain JSON number, so 6-digit ids pass through unchanged.
 */
export async function fetchCelesTrakTLEs(now: () => number = Date.now): Promise<CelesTrakGPElement[]> {
  const raw = await fetchRaw(now);

  // Remove objects that have already re-entered the atmosphere
  const extant = raw.filter((obj) => !obj.DECAY_DATE);
  logger.info(`Filtered ${raw.length - extant.length} decayed objects`);

  // Deduplicate by NORAD_CAT_ID, preferring the most recent EPOCH string
  // (ISO-8601 string comparison is valid here because the format is fixed-width)
  const byNorad = new Map<number, CelesTrakGPElement>();
  for (const obj of extant) {
    const existing = byNorad.get(obj.NORAD_CAT_ID);
    if (!existing || obj.EPOCH > existing.EPOCH) {
      byNorad.set(obj.NORAD_CAT_ID, obj);
    }
  }

  const deduped = Array.from(byNorad.values());
  if (extant.length !== deduped.length) {
    logger.info(`Removed ${extant.length - deduped.length} duplicate NORAD IDs`);
  }

  logger.info(`CelesTrak: ${deduped.length} unique in-orbit objects`);
  return deduped;
}
