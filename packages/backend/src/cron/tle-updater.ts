import cron from 'node-cron';
import { fetchFromSpaceTrack } from '../services/spacetrack.js';
import { fetchCelesTrakTLEs } from '../services/celestrak.js';
import { classifyObject, classifyObjectType } from '../services/classifier.js';
import { getInlineFacets } from '../enrichment/store.js';
import { buildOmm } from '../utils/omm.js';
import { writeCache, readCache, isCacheFresh } from '../cache/file-cache.js';
import { primeTlePayload } from '../cache/tle-payload-cache.js';
import {
  EnrichedTLEObject,
  SpaceTrackGPElement,
  CelesTrakGPElement,
  ClassifiableObject,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { ingestCurrentGp, isHistoryReady, type RawGpRecord } from '../history/index.js';

// Cron schedule: "0 2 * * *" = 02:00 UTC every day.
// Chosen to avoid peak hours and stay well away from adjacent cron runs.
const CRON_SCHEDULE = '0 2 * * *';

// ============================================================
// Helpers — normalise epoch strings to ISO-8601 with Z suffix
// ============================================================

function normaliseEpoch(epoch: string): string {
  // Both sources use "2024-03-15T12:00:00.000000" or "2024-03-15 12:00:00"
  // Normalise to "2024-03-15T12:00:00.000000Z"
  return epoch.replace(' ', 'T').replace(/(\.\d+)?$/, (m) => (m || '') + 'Z');
}

// ============================================================
// Space-Track path (primary)
// All numeric fields from Space-Track arrive as strings — parse them here
// before passing to the classifier or writing to the enriched object.
// ============================================================

function buildFromSpaceTrack(
  gpElements: SpaceTrackGPElement[],
): EnrichedTLEObject[] {
  const enriched: EnrichedTLEObject[] = [];

  for (const gp of gpElements) {
    // Build the OMM (validates every field json2satrec needs); skip if malformed.
    const normEpoch = normaliseEpoch(gp.EPOCH);
    const omm = buildOmm(gp, normEpoch);
    if (!omm) continue;

    // Space-Track returns numeric fields as strings — parse explicitly.
    const period      = parseFloat(gp.PERIOD);
    const eccentricity = parseFloat(gp.ECCENTRICITY);
    const apogee      = parseFloat(gp.APOAPSIS);
    const perigee     = parseFloat(gp.PERIAPSIS);
    const inclination = parseFloat(gp.INCLINATION);

    // Malformed elements occasionally appear — skip them.
    if (isNaN(period) || isNaN(eccentricity)) continue;

    const classifiable: ClassifiableObject = {
      period,
      eccentricity,
      objectType: gp.OBJECT_TYPE,
    };

    const { category, regime } = classifyObject(classifiable);

    // ObjectType straight from the LIVE GP OBJECT_TYPE — it's correct and current
    // (the old category-derived path collapsed every payload to 'unknown' once the
    // Space-Track ops-status field disappeared).
    const objectType = classifyObjectType(gp.OBJECT_TYPE);

    // Inline metadata facets: orbital status from satcat.csv; sectors/purpose from
    // UCS, with the program registry as payload-only fallback (covers post-snapshot
    // launches). Gate on the RAW type string — /^PAY/i covers Space-Track "PAYLOAD"
    // and CelesTrak "PAY"; classifyObjectType only recognizes the former.
    const noradId = parseInt(gp.NORAD_CAT_ID, 10);
    const name = gp.OBJECT_NAME.trim();
    const facets = getInlineFacets(noradId, name, /^PAY/i.test(gp.OBJECT_TYPE));

    enriched.push({
      noradId,
      name,
      omm,
      objectType,
      category,
      regime,
      countryCode:  gp.COUNTRY_CODE || '',
      launchDate:   gp.LAUNCH_DATE  || null,
      period:       isNaN(period)   ? 0 : period,
      apogee:       isNaN(apogee)   ? 0 : apogee,
      perigee:      isNaN(perigee)  ? 0 : perigee,
      inclination:  isNaN(inclination) ? 0 : inclination,
      rcsSize:      gp.RCS_SIZE     || null,
      epoch:        normEpoch,
      sectors:      facets.sectors,
      purpose:      facets.purpose,
      status:       facets.status,
      ...(facets.program ? { program: facets.program } : {}),
      ...(facets.launchTag ? { launchTag: facets.launchTag } : {}),
      ...(facets.owner ? { owner: facets.owner } : {}),
    });
  }

  return enriched;
}

// ============================================================
// CelesTrak fallback path
// CelesTrak returns proper JSON numbers — no parsing needed.
// OPS_STATUS_CODE is unavailable, so payloads classify as "unknown" unless
// OBJECT_TYPE itself makes the category unambiguous (debris / rocket_body).
// ============================================================

function buildFromCelesTrak(gpElements: CelesTrakGPElement[]): EnrichedTLEObject[] {
  const enriched: EnrichedTLEObject[] = [];

  for (const gp of gpElements) {
    const normEpoch = normaliseEpoch(gp.EPOCH);
    const omm = buildOmm(gp, normEpoch);
    if (!omm) continue;

    const classifiable: ClassifiableObject = {
      period:      gp.PERIOD,
      eccentricity: gp.ECCENTRICITY,
      objectType:  gp.OBJECT_TYPE,
      // No opsStatusCode — payloads will classify as "unknown"
    };

    const { category, regime } = classifyObject(classifiable);

    // ObjectType straight from the GP OBJECT_TYPE (current); status + sectors/purpose
    // from the enrichment join (satcat.csv orbital status, UCS sector/purpose) with
    // the program-registry payload fallback (raw-string gate: CelesTrak says "PAY").
    const objectType = classifyObjectType(gp.OBJECT_TYPE);
    const name = gp.OBJECT_NAME.trim();
    const facets = getInlineFacets(gp.NORAD_CAT_ID, name, /^PAY/i.test(gp.OBJECT_TYPE));

    enriched.push({
      noradId:     gp.NORAD_CAT_ID,
      name,
      omm,
      objectType,
      category,
      regime,
      countryCode:  gp.COUNTRY_CODE    ?? '',
      launchDate:   gp.LAUNCH_DATE     ?? null,
      period:       gp.PERIOD,
      apogee:       gp.APOAPSIS,
      perigee:      gp.PERIAPSIS,
      inclination:  gp.INCLINATION,
      rcsSize:      gp.RCS_SIZE        ?? null,
      epoch:        normEpoch,
      sectors:      facets.sectors,
      purpose:      facets.purpose,
      status:       facets.status,
      ...(facets.program ? { program: facets.program } : {}),
      ...(facets.launchTag ? { launchTag: facets.launchTag } : {}),
      ...(facets.owner ? { owner: facets.owner } : {}),
    });
  }

  return enriched;
}

// ============================================================
// Main update cycle
// ============================================================

/**
 * Run one full update cycle: try Space-Track first, fall back to CelesTrak.
 *
 * The cycle is skipped entirely if the cache is still fresh (< 24 h old).
 * This makes the function safe to call at startup AND from the cron job
 * without any separate rate-limit bookkeeping.
 */
export async function runUpdateCycle(): Promise<void> {
  // Guard: skip if cache is still within TTL.
  // This prevents hammering Space-Track if the process restarts repeatedly
  // or the cron fires unexpectedly.
  if (isCacheFresh()) {
    const v = readCache();
    logger.info(`Cache is fresh — skipping fetch (${v?.length ?? 0} objects cached)`);
    return;
  }

  const start = Date.now();
  logger.info('TLE update cycle starting');

  let enriched: EnrichedTLEObject[] | null = null;
  let source = 'unknown';
  // Raw provider records, captured for the optional history archive (the
  // "source of truth" layer). Null unless a fetch succeeded.
  let rawGp: RawGpRecord[] | null = null;

  // ── Primary: Space-Track ────────────────────────────────────────────────
  try {
    logger.info('Attempting Space-Track fetch (primary source)');
    const { gp } = await fetchFromSpaceTrack();
    enriched = buildFromSpaceTrack(gp);
    rawGp = gp;
    source = 'space-track';
  } catch (primaryErr) {
    logger.error(
      'Space-Track fetch failed — falling back to CelesTrak:',
      (primaryErr as Error).message,
    );

    // ── Fallback: CelesTrak ───────────────────────────────────────────────
    try {
      logger.info('Attempting CelesTrak fetch (fallback source)');
      const gp = await fetchCelesTrakTLEs();
      enriched = buildFromCelesTrak(gp);
      rawGp = gp;
      source = 'celestrak';
    } catch (fallbackErr) {
      logger.error('CelesTrak fallback also failed:', (fallbackErr as Error).message);
      // Both sources failed — preserve existing cache.
    }
  }

  if (!enriched) {
    const existing = readCache();
    if (existing) {
      logger.warn(`All sources failed — continuing to serve stale cache (${existing.length} objects)`);
    } else {
      logger.warn('All sources failed and no cache exists — API will return 503');
    }
    return;
  }

  writeCache(enriched);
  // Re-warm the in-memory gzipped /api/tle/all payload in-process so the next
  // request serves from memory instead of paying the one-time rebuild.
  primeTlePayload();

  // Fan the freshly-built catalog into the OPTIONAL history DB — reusing this one
  // daily fetch, no second pull. Guarded by readiness and a swallowed catch so it
  // can NEVER break the TLE serving path.
  if (isHistoryReady()) {
    try {
      await ingestCurrentGp(enriched, rawGp, source);
    } catch (err) {
      logger.error('History ingest failed (non-fatal):', (err as Error).message);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(
    `TLE update complete: ${enriched.length} objects from ${source} in ${elapsed}s`,
  );
}

/**
 * Schedule the daily cron job and optionally trigger an immediate fetch.
 *
 * @param runNow - Pass true when the cache is missing or stale at startup.
 */
export function scheduleTLEUpdater(runNow: boolean): void {
  if (runNow) {
    logger.info('Cache missing or stale at startup — triggering immediate fetch');
    runUpdateCycle().catch((err) => logger.error('Startup fetch error:', err));
  }

  const job = cron.schedule(CRON_SCHEDULE, () => {
    logger.info(`Cron triggered (${CRON_SCHEDULE})`);
    runUpdateCycle().catch((err) => logger.error('Cron cycle error:', err));
  });

  logger.info(`TLE updater scheduled: ${CRON_SCHEDULE} (daily at 02:00 UTC)`);
  job.start();
}
