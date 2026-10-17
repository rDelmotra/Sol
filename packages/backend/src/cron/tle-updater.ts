import cron from 'node-cron';
import { fetchFromSpaceTrack } from '../services/spacetrack.js';
import { fetchCelesTrakTLEs } from '../services/celestrak.js';
import { CelesTrakSkippedError } from '../services/celestrak-http.js';
import { overlayCatalog } from '../cache/catalog-overlay.js';
import { sendAlert, type AlertSender } from '../utils/alert.js';
import { classifyObject, classifyObjectType } from '../services/classifier.js';
import { getInlineFacets } from '../enrichment/store.js';
import { buildOmm } from '../utils/omm.js';
import {
  writeCache,
  readCache,
  cacheAgeMs,
  shouldSkipRefresh,
  assessCatalog,
  type UpdateTrigger,
} from '../cache/file-cache.js';
import { primeTlePayload } from '../cache/tle-payload-cache.js';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import {
  SpaceTrackGPElement,
  CelesTrakGPElement,
  ClassifiableObject,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { spacetrackUser, spacetrackPass, catalogMinRatio } from '../utils/config.js';
import {
  beginSpaceTrackAttempt,
  checkSpaceTrackGate,
  dailyFailureAlertDue,
  describeSkippedAttempt,
  markDailyAlertSent,
  recordSpaceTrackFailure,
  recordSpaceTrackSuccess,
  type AttemptState,
  type SpaceTrackAttempt,
} from '../cache/attempt-log.js';
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
// CelesTrak fallback path (an overlay on the cached catalog, see catalog-overlay.ts)
// CelesTrak returns proper JSON numbers — no parsing needed.
// OPS_STATUS_CODE is unavailable, so payloads classify as "unknown" unless
// OBJECT_TYPE itself makes the category unambiguous (debris / rocket_body).
// NORAD_CAT_ID is a plain number: ids of 100000 and up (JSON only, they do not fit
// the TLE format) go through the same way as 5-digit ids.
// ============================================================

export function buildFromCelesTrak(gpElements: CelesTrakGPElement[]): EnrichedTLEObject[] {
  const enriched: EnrichedTLEObject[] = [];

  for (const gp of gpElements) {
    if (!Number.isInteger(gp.NORAD_CAT_ID) || gp.NORAD_CAT_ID <= 0) continue;
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

/** A source answered, but the catalog is implausible (empty or far too small). */
class CatalogRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogRejectedError';
  }
}

/**
 * Everything runUpdateCycle talks to the outside world through. Tests inject
 * fakes (no network, no credentials, fixed clock); production uses the defaults.
 */
export interface UpdateCycleDeps {
  fetchSpaceTrack: () => Promise<{ gp: SpaceTrackGPElement[] }>;
  fetchCelesTrak: () => Promise<CelesTrakGPElement[]>;
  /** True when Space-Track credentials are set. Unset -> the attempt log is not used. */
  spaceTrackConfigured: () => boolean;
  now: () => number;
  /**
   * Send the "all 5 daily Space-Track attempts failed" alert. Called without waiting
   * (fire and forget); the real one never throws. Tests inject a recorder.
   */
  sendAlert: AlertSender;
  /**
   * Start a one-shot timer and return a function that cancels it. The timer must not
   * keep the process alive. Used for the retry after a Space-Track backoff.
   */
  schedule: (fn: () => void, delayMs: number) => () => void;
}

const defaultUpdateCycleDeps: UpdateCycleDeps = {
  fetchSpaceTrack: fetchFromSpaceTrack,
  fetchCelesTrak: fetchCelesTrakTLEs,
  spaceTrackConfigured: () => Boolean(spacetrackUser() && spacetrackPass()),
  now: () => Date.now(),
  sendAlert,
  schedule: (fn, delayMs) => {
    const timer = setTimeout(fn, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

// ============================================================
// One-shot retry after a Space-Track backoff
//
// When a cycle ends with nothing written (cache stale or missing) and the
// Space-Track gate is closed, the next login is allowed at a known time (retryAt).
// Without a timer the cycle would wait for the next 02:00 cron, up to 24 h. So one
// timer is armed for retryAt and runs the cycle again with the 'cron' trigger (it
// skips only when the cache is under 1 h old). At most one timer is pending.
// ============================================================

/** Wake up a little after retryAt so the gate has really opened. */
const RETRY_SLACK_MS = 1_000;
/** Never wait less than this, so a gate that is about to open cannot cause a hot loop. */
const RETRY_MIN_DELAY_MS = 1_000;
/** setTimeout cannot take more than 2^31 - 1 ms. The longest wait (next 00:00 UTC, under 24 h) is far below it. */
const RETRY_MAX_DELAY_MS = 2 ** 31 - 1;

let pendingRetry: { at: number; cancel: () => void } | null = null;

/** When the pending retry is due (epoch ms), or null when none is armed. */
export function pendingUpdateRetryAt(): number | null {
  return pendingRetry ? pendingRetry.at : null;
}

/** Cancel the pending retry, if any. Called after a successful write and on shutdown. */
export function cancelUpdateRetry(): void {
  if (!pendingRetry) return;
  pendingRetry.cancel();
  pendingRetry = null;
}

function armUpdateRetry(retryAt: number, deps: UpdateCycleDeps, overrides: Partial<UpdateCycleDeps>): void {
  // Idempotent: keep the pending timer unless the new time is earlier than it.
  if (pendingRetry) {
    if (pendingRetry.at <= retryAt) return;
    cancelUpdateRetry();
  }

  const delayMs = Math.min(
    RETRY_MAX_DELAY_MS,
    Math.max(RETRY_MIN_DELAY_MS, retryAt - deps.now() + RETRY_SLACK_MS),
  );
  const cancel = deps.schedule(() => {
    pendingRetry = null;
    logger.info('TLE update retry: the Space-Track wait is over — running the cycle again');
    runUpdateCycle('cron', overrides).catch((err) => logger.error('TLE update retry error:', err));
  }, delayMs);
  pendingRetry = { at: retryAt, cancel };
  logger.info(
    `TLE update retry scheduled for ${new Date(retryAt).toISOString()} ` +
      `(in about ${Math.max(1, Math.round(delayMs / 60_000))} min) — not waiting for the 02:00 cron`,
  );
}

// ============================================================
// Alert when the day's last Space-Track attempt fails
// ============================================================

const ALERT_ERROR_MAX_CHARS = 300;

function describeAge(ageMs: number | null): string {
  if (ageMs === null) return 'its age is not known';
  const hours = ageMs / 3_600_000;
  if (hours < 1) return `it is about ${Math.max(1, Math.round(ageMs / 60_000))} minutes old`;
  if (hours < 48) return `it is about ${Math.round(hours)} hours old`;
  return `it is about ${Math.round(hours / 24)} days old`;
}

/** Title and plain-English body of the alert. No secrets: only counts, an error text and an age. */
export function buildDailyFailureAlert(
  attempts: number,
  lastError: string,
  catalogAgeMs: number | null,
  hasCatalog: boolean,
): { title: string; body: string } {
  const error = lastError.replace(/\s+/g, ' ').trim().slice(0, ALERT_ERROR_MAX_CHARS) || 'no error text';
  const kept = hasCatalog
    ? `The site keeps serving the previous catalog (${describeAge(catalogAgeMs)}).`
    : 'There is no catalog on disk, so the site has no data to serve.';
  return {
    title: 'OrbitWatch: Space-Track failed all daily attempts',
    body:
      `All ${attempts} Space-Track attempts today (UTC) failed. Last error: ${error}. ` +
      `${kept} No more Space-Track logins will be made until 00:00 UTC.`,
  };
}

/** Mark the day as alerted (so a restart does not repeat it), then send without waiting. */
function raiseDailyFailureAlert(deps: UpdateCycleDeps, failed: AttemptState, lastError: string): void {
  markDailyAlertSent(failed);
  const ageMs = cacheAgeMs(deps.now());
  const alert = buildDailyFailureAlert(failed.attemptsToday ?? 0, lastError, ageMs, ageMs !== null);
  try {
    Promise.resolve(deps.sendAlert(alert)).catch((err) =>
      logger.warn(`Alert sender failed (${(err as Error)?.name ?? 'error'})`),
    );
  } catch (err) {
    logger.warn(`Alert sender failed (${(err as Error)?.name ?? 'error'})`);
  }
}

/**
 * Run one full update cycle: try Space-Track first, fall back to CelesTrak.
 *
 * Skip policy (see shouldSkipRefresh):
 *  - 'boot': skipped while the cache is inside the 24 h TTL.
 *  - 'cron': skipped only if the cache is under 1 h old. The daily run must
 *    always refresh; the old 24 h guard skipped every other day because the
 *    previous write is 23h59m old at the next 02:00:00 tick.
 * The minimum-age guard keeps a restart loop or double trigger from
 * hammering Space-Track.
 *
 * Space-Track politeness (see cache/attempt-log.ts): every login is recorded in
 * a small file on the volume. After a failure the next login waits 15 min, 30 min,
 * 1 h, 2 h, 4 h, then 6 h; after a success it waits 1 h. A restart does not reset
 * the wait. On top of that there are at most 5 logins per UTC day (boot, cron and
 * retry timer all count, success or failure); at the cap the gate stays shut until
 * 00:00 UTC, and a new UTC day starts the count again, so the cap never blocks the
 * 02:00 cron. While Space-Track is held back, the cycle goes straight to the
 * CelesTrak fallback and the stale cache keeps serving, exactly as it does after
 * a Space-Track failure. The backoff cap is far below the daily cron interval, so
 * it never blocks a whole day. If the cycle then writes nothing, one retry timer is
 * armed for the moment the wait ends (see armUpdateRetry).
 *
 * Alert: when the day's 5th attempt fails and none of the day's attempts succeeded,
 * deps.sendAlert is called once (fire and forget). The day is remembered in the
 * attempt log (`alertSentDay`), so a restart does not send it again.
 *
 * CelesTrak is a fallback OVERLAY, never a replacement (no CelesTrak group is the
 * full catalog): its records replace cached ones only when their epoch is newer, new
 * ids are added, everything else in the cache stays (see catalog-overlay.ts). It is
 * asked at most once per 2 hours (services/celestrak.ts); a gated call is skipped
 * and the stale cache keeps serving. An overlay result is NOT ingested into the
 * history database (a partial day would misrepresent history) and no raw archive is
 * written for it: history stays Space-Track-only.
 *
 * Size guard (see assessCatalog): a source can answer with success and still send
 * nothing useful (`200 []`, or a page list cut short). A catalog with 0 objects, or
 * with under 50% of the cached object count (CATALOG_MIN_RATIO), is refused. A
 * refused Space-Track answer is logged at ERROR, recorded as a Space-Track failure
 * (so the backoff applies) and the cycle falls through to CelesTrak. If CelesTrak is
 * refused or fails too, the cycle returns without touching the cache, version.json,
 * the payload cache or the history DB. With no cache, any non-empty catalog is taken.
 * (An overlay is never smaller than the cache, so for CelesTrak the guard only
 * catches an empty answer.)
 */
export async function runUpdateCycle(
  trigger: UpdateTrigger = 'boot',
  overrides: Partial<UpdateCycleDeps> = {},
): Promise<void> {
  const deps: UpdateCycleDeps = { ...defaultUpdateCycleDeps, ...overrides };

  const ageMs = cacheAgeMs(deps.now());
  if (shouldSkipRefresh(ageMs, trigger)) {
    const v = readCache();
    const ageMin = Math.round((ageMs ?? 0) / 60_000);
    logger.info(`Cache is fresh for ${trigger} (${ageMin} min old) — skipping fetch (${v?.length ?? 0} objects cached)`);
    return;
  }

  const start = deps.now();
  logger.info('TLE update cycle starting');

  let enriched: EnrichedTLEObject[] | null = null;
  let source = 'unknown';
  // Raw provider records, captured for the optional history archive (the
  // "source of truth" layer). Null unless a fetch succeeded.
  let rawGp: RawGpRecord[] | null = null;
  // Set when a Space-Track login really starts; settled (success/failure) below.
  let attempt: SpaceTrackAttempt | null = null;

  // Size of the catalog on disk, read once and only if a fetch returns data (it is a
  // 25 MB parse). null = no readable cache. Used to refuse implausible results.
  let cachedCatalog: EnrichedTLEObject[] | null | undefined;
  const readCachedCatalog = (): EnrichedTLEObject[] | null => {
    if (cachedCatalog === undefined) cachedCatalog = readCache();
    return cachedCatalog;
  };
  const cachedCatalogCount = (): number | null => readCachedCatalog()?.length ?? null;
  const minRatio = catalogMinRatio();

  // ── Primary: Space-Track ────────────────────────────────────────────────
  // The attempt log applies only when credentials are set; without them the
  // fetch throws before any network call, so there is nothing to be polite about.
  const gated = deps.spaceTrackConfigured();
  const gate = gated ? checkSpaceTrackGate(deps.now()) : ({ allowed: true } as const);

  if (!gate.allowed) {
    logger.info(describeSkippedAttempt(gate, deps.now()));
  } else {
    if (gated) attempt = beginSpaceTrackAttempt(deps.now());
    try {
      logger.info('Attempting Space-Track fetch (primary source)');
      const { gp } = await deps.fetchSpaceTrack();
      const built = buildFromSpaceTrack(gp);
      const verdict = assessCatalog(built.length, cachedCatalogCount(), minRatio);
      if (!verdict.ok) {
        throw new CatalogRejectedError(
          `Space-Track catalog refused (${gp.length} records fetched, ${built.length} usable): ${verdict.reason}`,
        );
      }
      enriched = built;
      rawGp = gp;
      source = 'space-track';
    } catch (primaryErr) {
      // A refused catalog counts as a Space-Track failure, so the backoff applies.
      const failedAt = attempt ? recordSpaceTrackFailure(attempt, deps.now()) : null;
      attempt = null;
      logger.error(
        primaryErr instanceof CatalogRejectedError
          ? `${primaryErr.message} — falling back to CelesTrak`
          : `Space-Track fetch failed — falling back to CelesTrak: ${(primaryErr as Error).message}`,
      );
      if (failedAt && dailyFailureAlertDue(failedAt)) {
        raiseDailyFailureAlert(deps, failedAt, (primaryErr as Error).message);
      }
    }
  }

  // ── Fallback: CelesTrak (overlay on the cached catalog) ──────────────────
  if (!enriched) {
    try {
      logger.info('Attempting CelesTrak fetch (fallback source, overlay on the cached catalog)');
      const gp = await deps.fetchCelesTrak();
      const built = buildFromCelesTrak(gp);
      // An empty answer is refused outright; the overlay below can never be smaller
      // than the cache, so the size check there would not notice it.
      const answer = assessCatalog(built.length, null, minRatio);
      if (!answer.ok) {
        logger.error(
          `CelesTrak catalog refused (${gp.length} records fetched, ${built.length} usable): ${answer.reason}`,
        );
      } else {
        const overlay = overlayCatalog(readCachedCatalog(), built);
        const verdict = assessCatalog(overlay.catalog.length, cachedCatalogCount(), minRatio);
        if (verdict.ok) {
          logger.info(
            `CelesTrak overlay: ${overlay.replaced} cached objects replaced by newer epochs, ` +
              `${overlay.added} added, ${overlay.catalog.length - overlay.replaced - overlay.added} kept as cached`,
          );
          enriched = overlay.catalog;
          source = 'celestrak';
          // rawGp stays null: the raw archive is Space-Track-only.
        } else {
          logger.error(
            `CelesTrak catalog refused (${gp.length} records fetched, ${built.length} usable): ${verdict.reason}`,
          );
        }
      }
    } catch (fallbackErr) {
      if (fallbackErr instanceof CelesTrakSkippedError) {
        logger.info(`${fallbackErr.message} — keeping the stale cache`);
      } else {
        logger.error('CelesTrak fallback also failed:', (fallbackErr as Error).message);
      }
      // Both sources failed — preserve existing cache.
    }
  }

  if (!enriched) {
    // Nothing usable: no writeCache, no payload warm-up, no history ingest. The
    // cache on disk (and its version.json) stays exactly as it was.
    const existing = cachedCatalogCount();
    if (existing !== null) {
      logger.warn(`All sources failed or were refused — continuing to serve stale cache (${existing} objects)`);
    } else {
      logger.warn('All sources failed and no cache exists — API will return 503');
    }

    // Nothing was written. If Space-Track is only waiting out its backoff, come back
    // when the wait is over instead of waiting for the next 02:00 cron. A gate that is
    // already open (for example an unwritable attempt log) gets no timer: that would
    // be a hot loop.
    if (gated) {
      const next = checkSpaceTrackGate(deps.now());
      if (!next.allowed) armUpdateRetry(next.retryAt, deps, overrides);
    }
    return;
  }

  writeCache(enriched);
  // The cache is fresh again, so a pending retry has nothing left to do.
  cancelUpdateRetry();
  // The Space-Track attempt counts as a success only once its data is on disk.
  // If anything above threw (parse bug, disk full), the pending record stays a
  // failure and the next login backs off instead of re-downloading at once.
  if (attempt) recordSpaceTrackSuccess(deps.now(), attempt);

  // Re-warm the in-memory gzipped /api/tle/all payload in-process so the next
  // request serves from memory instead of paying the one-time rebuild.
  primeTlePayload();

  // Fan the freshly-built catalog into the OPTIONAL history DB — reusing this one
  // daily fetch, no second pull. Guarded by readiness and a swallowed catch so it
  // can NEVER break the TLE serving path.
  // Space-Track only: a CelesTrak overlay is a partial, mixed-age day and would
  // misrepresent history.
  if (source !== 'space-track') {
    logger.info(`History ingest skipped: the catalog came from ${source}, history is Space-Track-only`);
  } else if (isHistoryReady()) {
    try {
      await ingestCurrentGp(enriched, rawGp, source);
    } catch (err) {
      logger.error('History ingest failed (non-fatal):', (err as Error).message);
    }
  }

  const elapsed = ((deps.now() - start) / 1000).toFixed(1);
  logger.info(
    `TLE update complete: ${enriched.length} objects from ${source} in ${elapsed}s`,
  );
}

/** Returned by scheduleTLEUpdater so a shutdown (or a test) can stop everything it started. */
export interface TleUpdaterHandle {
  /** Stop the daily cron job and cancel any pending retry timer. */
  stop: () => void;
}

/**
 * Schedule the daily cron job and optionally trigger an immediate fetch.
 *
 * @param runNow - Pass true when the cache is missing or stale at startup.
 */
export function scheduleTLEUpdater(runNow: boolean): TleUpdaterHandle {
  if (runNow) {
    logger.info('Cache missing or stale at startup — triggering immediate fetch');
    runUpdateCycle('boot').catch((err) => logger.error('Startup fetch error:', err));
  }

  const job = cron.schedule(CRON_SCHEDULE, () => {
    logger.info(`Cron triggered (${CRON_SCHEDULE})`);
    runUpdateCycle('cron').catch((err) => logger.error('Cron cycle error:', err));
  });

  logger.info(`TLE updater scheduled: ${CRON_SCHEDULE} (daily at 02:00 UTC)`);
  job.start();

  return {
    stop: () => {
      job.stop();
      cancelUpdateRetry();
    },
  };
}
