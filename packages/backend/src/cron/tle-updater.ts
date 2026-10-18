import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { fetchFromSpaceTrack } from '../services/spacetrack.js';
import { CELESTRAK_FALLBACK_GROUP, fetchCelesTrakTLEs } from '../services/celestrak.js';
import { CelesTrakSkippedError } from '../services/celestrak-http.js';
import { overlayCatalog } from '../cache/catalog-overlay.js';
import { alertSentOn, markAlertSent } from '../cache/alert-state.js';
import { readCelesTrakAttempts } from '../cache/celestrak-attempts.js';
import { sendAlert, type AlertMessage, type AlertSender } from '../utils/alert.js';
import { formatDiskUsage, readDiskUsage } from '../utils/disk-usage.js';
import { reportDiskAndAlert } from '../utils/volume-alert.js';
import { classifyObject, classifyObjectType } from '../services/classifier.js';
import { getInlineFacets, getMetadata } from '../enrichment/store.js';
import { buildOmm } from '../utils/omm.js';
import { summarizeOrbit } from '../utils/orbit-summary.js';
import {
  writeCache,
  readCache,
  cacheAgeMs,
  cacheTempPaths,
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
  DAILY_ATTEMPT_CAP,
  beginSpaceTrackAttempt,
  checkSpaceTrackGate,
  dailyFailureAlertDue,
  describeSkippedAttempt,
  evaluateGate,
  markDailyAlertSent,
  readAttemptState,
  recordSpaceTrackFailure,
  recordSpaceTrackSuccess,
  utcDay,
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

export function buildFromSpaceTrack(
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
//
// CelesTrak's GP JSON has ONLY the 17 OMM keys (see CelesTrakGPElement). It has no
// OBJECT_TYPE, PERIOD, APOAPSIS, PERIAPSIS, COUNTRY_CODE, LAUNCH_DATE or RCS_SIZE. So:
//   - period, apogee and perigee are DERIVED from MEAN_MOTION and ECCENTRICITY, with
//     Space-Track's definition (apsides are km above the surface; utils/orbit-summary.ts)
//   - the regime comes from that period
//   - for an id that is NOT in the cache, the fields CelesTrak lacks get the same
//     "unknown" defaults the Space-Track path uses ('' country, null launch date and
//     size), except where the enrichment layer (GCAT/UCS, the same join the
//     Space-Track path uses for status/sectors) knows the object type or country
//   - for an id that IS in the cache, only the orbit part of the record is taken
//     (mergeNewerOrbit below); everything else stays as Space-Track had it
// OPS_STATUS_CODE is unavailable, so payloads classify as "unknown" category.
// NORAD_CAT_ID is a plain number: ids of 100000 and up (JSON only, they do not fit
// the TLE format) go through the same way as 5-digit ids.
// ============================================================

/** AnalyticObjectType (enrichment) -> the raw OBJECT_TYPE spelling the classifier reads. */
const ENRICHED_TYPE_TO_RAW: Record<string, string> = {
  payload: 'PAYLOAD',
  rocket_body: 'ROCKET BODY',
  debris: 'DEBRIS',
};

export function buildFromCelesTrak(gpElements: CelesTrakGPElement[]): EnrichedTLEObject[] {
  const enriched: EnrichedTLEObject[] = [];

  for (const gp of gpElements) {
    if (!Number.isInteger(gp.NORAD_CAT_ID) || gp.NORAD_CAT_ID <= 0) continue;
    // A DECAY_DATE (when the data has one) means the object has re-entered. CelesTrak's
    // GP JSON has none today, so this is only a guard; fetchCelesTrakTLEs drops them too.
    if (gp.DECAY_DATE) continue;
    const normEpoch = normaliseEpoch(gp.EPOCH);
    const omm = buildOmm(gp, normEpoch);
    if (!omm) continue;

    // Derived, never read from CelesTrak (it does not send them). A record that does not
    // describe a bound orbit (mean motion <= 0, e outside [0, 1)) is skipped, like a
    // Space-Track record with a NaN period.
    const orbit = summarizeOrbit(gp.MEAN_MOTION, gp.ECCENTRICITY);
    if (!orbit) continue;

    const name = gp.OBJECT_NAME.trim();
    const known = getMetadata(gp.NORAD_CAT_ID);
    // OBJECT_TYPE when the data has one, else what the enrichment join knows, else unknown.
    const rawType = gp.OBJECT_TYPE ?? ENRICHED_TYPE_TO_RAW[known?.objectType ?? ''] ?? '';
    const objectType = classifyObjectType(rawType);
    const facets = getInlineFacets(gp.NORAD_CAT_ID, name, objectType === 'satellite');

    const { category, regime } = classifyObject({
      period: orbit.period,
      eccentricity: gp.ECCENTRICITY,
      objectType: rawType,
      // No opsStatusCode — payloads will classify as "unknown"
    });

    enriched.push({
      noradId:     gp.NORAD_CAT_ID,
      name,
      omm,
      objectType,
      category,
      regime,
      countryCode:  gp.COUNTRY_CODE || facets.operatorCountry || '',
      launchDate:   gp.LAUNCH_DATE  || null,
      period:       orbit.period,
      apogee:       orbit.apogee,
      perigee:      orbit.perigee,
      inclination:  gp.INCLINATION,
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

/**
 * What a NEWER CelesTrak record changes on a cached object. `candidate` was built by
 * buildFromCelesTrak. Only the orbit and what is derived from it is taken: the omm
 * (the 17 keys CelesTrak really has), epoch, inclination, period, apogee, perigee and
 * the regime. Type, category, country, launch date, size, name and every enrichment
 * facet stay as cached, because CelesTrak does not carry them. A candidate value that
 * is missing or not a finite number never overwrites a cached one. Returns a new
 * object; neither input is changed.
 */
export function mergeNewerOrbit(cached: EnrichedTLEObject, candidate: EnrichedTLEObject): EnrichedTLEObject {
  const merged: EnrichedTLEObject = { ...cached };
  if (candidate.omm) merged.omm = candidate.omm;
  if (candidate.epoch) merged.epoch = candidate.epoch;
  for (const key of ['inclination', 'period', 'apogee', 'perigee'] as const) {
    const v = candidate[key];
    if (typeof v === 'number' && Number.isFinite(v)) merged[key] = v;
  }
  if (candidate.regime) merged.regime = candidate.regime;
  return merged;
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
 * Why a cycle runs. 'boot' and 'cron' follow shouldSkipRefresh. 'retry' is the one-shot
 * timer that comes back for Space-Track after a backoff: it never skips because the cache
 * is fresh (CelesTrak may have just refreshed it; that must not stop the Space-Track
 * retries), it only asks Space-Track, and Space-Track's own gate decides.
 */
export type CycleTrigger = UpdateTrigger | 'retry';

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
   * Send an alert (the day's "all 5 Space-Track attempts failed" one, or the write-failure
   * one). Called without waiting (fire and forget); the real one never throws. Tests inject
   * a recorder.
   */
  sendAlert: AlertSender;
  /**
   * Start a one-shot timer and return a function that cancels it. The timer must not
   * keep the process alive. Used for the retry after a Space-Track backoff.
   */
  schedule: (fn: () => void, delayMs: number) => () => void;
  /** Write tle-cache.json and version.json. May throw (disk full, permissions). */
  writeCache: (data: EnrichedTLEObject[]) => void;
  /** The disk usage line for the write-failure alert ("disk 1.0 MB / 2.0 MB (50%)"), or null. Never throws. */
  diskUsageLine: () => Promise<string | null>;
}

/** The disk usage line, or null when it cannot be read within 3 s. */
async function readDiskUsageLine(): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const usage = await Promise.race([
      readDiskUsage(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3_000);
        timer.unref();
      }),
    ]);
    return usage ? formatDiskUsage(usage) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  writeCache,
  diskUsageLine: readDiskUsageLine,
};

// ============================================================
// One-shot retry for Space-Track
//
// Space-Track is the primary source and CelesTrak is only a fallback overlay, so a
// CelesTrak write must NOT end the Space-Track retries. After every cycle in which
// Space-Track did not deliver (it failed, was refused, or was held back by its gate),
// one timer is armed for the next moment the gate allows a login, whether or not
// CelesTrak wrote the cache. Without it the next attempt would wait for the 02:00 cron,
// up to 24 h. The timer runs the cycle with the 'retry' trigger. A Space-Track success
// cancels it. At most one timer is pending. When the day's 5 attempts are used the
// gate's next time is 00:00 UTC, so the timer waits for midnight and the next day gets
// its own 5 attempts.
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

/** Cancel the pending retry, if any. Called after a Space-Track success and on shutdown. */
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
    logger.info('TLE update retry: the Space-Track wait is over — trying Space-Track again');
    runUpdateCycle('retry', overrides).catch((err) => logger.error('TLE update retry error:', err));
  }, delayMs);
  pendingRetry = { at: retryAt, cancel };
  logger.info(
    `TLE update retry scheduled for ${new Date(retryAt).toISOString()} ` +
      `(in about ${Math.max(1, Math.round(delayMs / 60_000))} min) — not waiting for the 02:00 cron`,
  );
}

// ============================================================
// Alerts
// ============================================================

const ALERT_ERROR_MAX_CHARS = 300;

function describeAge(ageMs: number | null): string {
  if (ageMs === null) return 'its age is not known';
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  const hours = ageMs / 3_600_000;
  if (hours < 1) return `it is about ${minutes} minute${minutes === 1 ? '' : 's'} old`;
  if (hours < 48) return `it is about ${Math.round(hours)} hours old`;
  return `it is about ${Math.round(hours / 24)} days old`;
}

/** Extra facts for the daily alert text. All optional. */
export interface DailyAlertFacts {
  /** UTC days in a row that ended with this alert (this one included). Shown when above 1. */
  daysInARow?: number;
  /** True when CelesTrak refreshed the catalog in the same cycle; false when it did not. */
  celestrakRefreshed?: boolean;
}

/** Title and plain-English body of the alert. No secrets: only counts, an error text and an age. */
export function buildDailyFailureAlert(
  attempts: number,
  lastError: string,
  catalogAgeMs: number | null,
  hasCatalog: boolean,
  facts: DailyAlertFacts = {},
): { title: string; body: string } {
  const error = lastError.replace(/\s+/g, ' ').trim().slice(0, ALERT_ERROR_MAX_CHARS) || 'no error text';
  const streak =
    facts.daysInARow !== undefined && facts.daysInARow > 1 ? ` This is day ${facts.daysInARow} in a row.` : '';
  let kept: string;
  if (!hasCatalog) {
    kept = 'There is no catalog on disk, so the site has no data to serve.';
  } else if (facts.celestrakRefreshed === true) {
    kept =
      `CelesTrak kept the catalog fresh (${describeAge(catalogAgeMs)}): orbits are current, ` +
      'names, countries and sizes are from the last good Space-Track fetch.';
  } else {
    kept =
      `The site keeps serving the previous catalog (${describeAge(catalogAgeMs)}).` +
      (facts.celestrakRefreshed === false ? ' CelesTrak did not refresh it either.' : '');
  }
  return {
    title: `OrbitWatch: Space-Track failed all daily attempts${streak ? ` (day ${facts.daysInARow} in a row)` : ''}`,
    body:
      `All ${attempts} Space-Track attempts today (UTC) failed. Last error: ${error}.${streak} ` +
      `${kept} No more Space-Track logins today; the next try is after 00:00 UTC.`,
  };
}

/** Title and body of the "the catalog could not be written" alert. No secrets. */
export function buildWriteFailureAlert(facts: {
  error: string;
  source: string;
  catalogAgeMs: number | null;
  hasCatalog: boolean;
  diskLine: string | null;
  /** Space-Track attempts used today, when this write belonged to one. */
  attemptsToday?: number;
  /** True when this failed write was the day's 5th Space-Track attempt (it replaces the daily alert). */
  dailyCapFailed?: boolean;
}): { title: string; body: string } {
  const error = facts.error.replace(/\s+/g, ' ').trim().slice(0, ALERT_ERROR_MAX_CHARS) || 'no error text';
  const kept = facts.hasCatalog
    ? `The site keeps serving the previous catalog (${describeAge(facts.catalogAgeMs)}).`
    : 'There is no catalog on disk, so the site has no data to serve.';
  const attempts =
    facts.attemptsToday !== undefined
      ? ` It counted as failed Space-Track attempt ${facts.attemptsToday} of ${DAILY_ATTEMPT_CAP} today.` +
        (facts.dailyCapFailed ? ' All of today\'s attempts have failed.' : '')
      : '';
  return {
    title: 'OrbitWatch: DISK or WRITE problem, the catalog could not be saved',
    body:
      `A catalog from ${facts.source} was fetched but writing it to disk failed: ${error}.${attempts} ` +
      `${kept} ${facts.diskLine ? `${facts.diskLine}. ` : ''}` +
      'Check the free space and the write permission of the data volume (CACHE_DIR).',
  };
}

/** The alert for 'CelesTrak was used as the fallback'. Plain text, bounded, no secrets. */
export function buildCelesTrakFallbackAlert(facts: {
  spaceTrackProblem: string;
  overlay: { replaced: number; added: number; total: number } | null;
}): AlertMessage {
  const problem = facts.spaceTrackProblem.replace(/\s+/g, ' ').slice(0, 300);
  const what = facts.overlay
    ? `${facts.overlay.replaced} satellites got newer orbits, ${facts.overlay.added} were added, the other ` +
      `${facts.overlay.total - facts.overlay.replaced - facts.overlay.added} stay as they were. ` +
      'Their type, country and launch data were kept.'
    : 'The saved catalog was updated with newer orbits.';
  return {
    title: 'OrbitWatch: CelesTrak was used as the fallback',
    body:
      `Space-Track did not supply today's catalog (${problem}), so the catalog was refreshed from CelesTrak instead. ` +
      `${what} Debris and objects CelesTrak does not list keep their last Space-Track values. ` +
      'Space-Track is still retried (up to 5 times a day) and takes over when it works. ' +
      'The satellite history database is not changed by this.',
  };
}

/** Send without waiting; a sender that throws or rejects is logged at WARN and ignored. */
function sendFireAndForget(deps: UpdateCycleDeps, alert: { title: string; body: string }): void {
  try {
    Promise.resolve(deps.sendAlert(alert)).catch((err) =>
      logger.warn(`Alert sender failed (${(err as Error)?.name ?? 'error'})`),
    );
  } catch (err) {
    logger.warn(`Alert sender failed (${(err as Error)?.name ?? 'error'})`);
  }
}

/** CelesTrak counts as "kept the catalog fresh" when its last good download is newer than this. */
const CELESTRAK_FRESH_WINDOW_MS = 6 * 60 * 60_000;

/** Did CelesTrak's last download (per its persisted attempt log) succeed within the last 6 hours? */
function celestrakDownloadedRecently(now: number): boolean {
  const last = readCelesTrakAttempts()?.[CELESTRAK_FALLBACK_GROUP];
  if (!last || last.lastOutcome !== 'success') return false;
  const at = Date.parse(last.lastAttemptAt);
  return Number.isFinite(at) && now - at < CELESTRAK_FRESH_WINDOW_MS;
}

/** Mark the day as alerted (so a restart does not repeat it), then send without waiting. */
function raiseDailyFailureAlert(
  deps: UpdateCycleDeps,
  failed: AttemptState,
  lastError: string,
  celestrakRefreshed: boolean,
): void {
  const marked = markDailyAlertSent(failed);
  const ageMs = cacheAgeMs(deps.now());
  sendFireAndForget(
    deps,
    buildDailyFailureAlert(failed.attemptsToday ?? 0, lastError, ageMs, ageMs !== null, {
      daysInARow: marked.alertStreakDays,
      // this cycle's overlay, or a good CelesTrak download earlier today (its own 2 h gate may
      // have held this cycle's request back although the catalog was refreshed an hour ago)
      celestrakRefreshed: celestrakRefreshed || celestrakDownloadedRecently(deps.now()),
    }),
  );
}

/** Delete the temp files writeCache may have left behind. Only those two names; failures are ignored. */
function removeLeftoverCacheTempFiles(): void {
  for (const p of cacheTempPaths()) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      logger.warn(`Could not remove leftover temp file ${path.basename(p)}: ${(err as Error).message}`);
    }
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
 *  - 'retry' (the Space-Track retry timer): never skipped for a fresh cache, because
 *    CelesTrak may have just refreshed it. If Space-Track's gate is still closed it
 *    only re-arms the timer.
 * The minimum-age guard keeps a restart loop or double trigger from
 * hammering Space-Track.
 *
 * Space-Track politeness (see cache/attempt-log.ts): every login is recorded in
 * a small file on the volume. At most 5 logins per UTC day (boot, cron and retry
 * timer all count, success or failure). Between the attempts of one UTC day the wait
 * is 15 min, 30 min, 1 h, 2 h (computed from that day's failures, so every day can
 * use all 5: the 5th is about 3 h 45 min after the 1st); after a success it waits 1 h.
 * The backoff starts again each UTC day. A restart does not reset the wait. While
 * Space-Track is held back, the cycle goes straight to the CelesTrak fallback and the
 * stale cache keeps serving.
 *
 * Retry: after every cycle in which Space-Track did not deliver (failed, refused or held
 * back) one retry timer is armed for the next time its gate allows a login (00:00 UTC
 * when the day's 5 are used), EVEN IF CelesTrak wrote the cache. Only a Space-Track
 * success cancels it. CelesTrak is not asked again by the retry unless its own 2 hour
 * gate is open.
 *
 * Alert: when the day's 5th attempt fails and none of the day's attempts succeeded,
 * deps.sendAlert is called once (fire and forget), after the CelesTrak fallback so the
 * text can say whether CelesTrak kept the catalog fresh. The day is remembered in the
 * attempt log (`alertSentDay`), so a restart does not send it again; the next UTC day
 * can alert again, so an outage alerts every day it lasts.
 *
 * Write failure: if writing the catalog throws (disk full, permissions), the Space-Track
 * attempt (if this data came from one) is recorded as a failure, an ERROR is logged, the
 * leftover temp files are removed, an alert titled as a disk or write problem is sent
 * (at most once per UTC day), the retry timer is armed, and the old cache keeps serving.
 *
 * CelesTrak is a fallback OVERLAY, never a replacement (no CelesTrak group is the
 * full catalog): its records update cached ones only when their epoch is newer (and only
 * their orbit data, see mergeNewerOrbit), new ids are added, everything else in the
 * cache stays (see catalog-overlay.ts). It is
 * asked at most once per 2 hours (services/celestrak.ts); a gated call is skipped
 * and the stale cache keeps serving. An overlay result is NOT ingested into the
 * history database (a partial day would misrepresent history) and no raw archive is
 * written for it: history stays Space-Track-only.
 *
 * Size guard (see assessCatalog): a source can answer with success and still send
 * nothing useful (`200 []`, or a page list cut short). A catalog with 0 objects, or
 * with under 50% of the cached object count (CATALOG_MIN_RATIO), is refused. A
 * refused Space-Track answer is logged at ERROR, recorded as a Space-Track failure
 * (so the backoff, the cap and the alert apply) and the cycle falls through to
 * CelesTrak. If CelesTrak is refused or fails too, the cycle returns without touching
 * the cache, version.json, the payload cache or the history DB. With no cache, any
 * non-empty catalog is taken. (An overlay is never smaller than the cache, so for
 * CelesTrak the guard only catches an empty answer.)
 */
export async function runUpdateCycle(
  trigger: CycleTrigger = 'boot',
  overrides: Partial<UpdateCycleDeps> = {},
): Promise<void> {
  const deps: UpdateCycleDeps = { ...defaultUpdateCycleDeps, ...overrides };

  const ageMs = cacheAgeMs(deps.now());
  if (trigger !== 'retry' && shouldSkipRefresh(ageMs, trigger)) {
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
  // Set when Space-Track fails this cycle and that failure was the day's last.
  let dailyAlert: { failed: AttemptState; error: string } | null = null;
  // Why Space-Track did not supply this cycle's catalog (for the CelesTrak fallback alert).
  let spaceTrackProblem = 'Space-Track was not tried';
  let lastOverlay: { replaced: number; added: number; total: number } | null = null;

  // Size of the catalog on disk, read once and only if a fetch returns data (it is a
  // 25 MB parse). null = no readable cache. Used to refuse implausible results.
  let cachedCatalog: EnrichedTLEObject[] | null | undefined;
  const readCachedCatalog = (): EnrichedTLEObject[] | null => {
    if (cachedCatalog === undefined) cachedCatalog = readCache();
    return cachedCatalog;
  };
  const cachedCatalogCount = (): number | null => readCachedCatalog()?.length ?? null;
  const minRatio = catalogMinRatio();

  // The attempt log applies only when credentials are set; without them the
  // fetch throws before any network call, so there is nothing to be polite about.
  const gated = deps.spaceTrackConfigured();

  /**
   * End of every cycle that did not get Space-Track data onto the disk: send the day's
   * alert if one is due, then arm the one-shot Space-Track retry for the moment its gate
   * opens. A gate that is already open (for example an unwritable attempt log) gets no
   * timer: that would be a hot loop.
   */
  const settleWithoutSpaceTrack = (celestrakRefreshed: boolean): void => {
    if (dailyAlert) raiseDailyFailureAlert(deps, dailyAlert.failed, dailyAlert.error, celestrakRefreshed);
    if (gated) {
      const next = checkSpaceTrackGate(deps.now());
      if (!next.allowed) armUpdateRetry(next.retryAt, deps, overrides);
    }
  };

  // ── Primary: Space-Track ────────────────────────────────────────────────
  const gate = gated ? checkSpaceTrackGate(deps.now()) : ({ allowed: true } as const);

  if (!gate.allowed) {
    logger.info(describeSkippedAttempt(gate, deps.now()));
    spaceTrackProblem = describeSkippedAttempt(gate, deps.now());
    if (trigger === 'retry') {
      // The timer fired early (a clock jump). This cycle exists only for Space-Track.
      settleWithoutSpaceTrack(false);
      return;
    }
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
      spaceTrackProblem = (primaryErr as Error).message;
      // A refused catalog counts as a Space-Track failure, so the backoff applies.
      const failedAt = attempt ? recordSpaceTrackFailure(attempt, deps.now()) : null;
      attempt = null;
      logger.error(
        primaryErr instanceof CatalogRejectedError
          ? `${primaryErr.message} — falling back to CelesTrak`
          : `Space-Track fetch failed — falling back to CelesTrak: ${(primaryErr as Error).message}`,
      );
      // The alert itself goes out after the CelesTrak step, once we know whether it helped.
      if (failedAt && dailyFailureAlertDue(failedAt)) {
        dailyAlert = { failed: failedAt, error: (primaryErr as Error).message };
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
        const overlay = overlayCatalog(readCachedCatalog(), built, mergeNewerOrbit);
        const verdict = assessCatalog(overlay.catalog.length, cachedCatalogCount(), minRatio);
        if (verdict.ok) {
          logger.info(
            `CelesTrak overlay: ${overlay.replaced} cached objects updated to newer orbits (metadata kept), ` +
              `${overlay.added} added, ${overlay.catalog.length - overlay.replaced - overlay.added} kept as cached`,
          );
          enriched = overlay.catalog;
          source = 'celestrak';
          lastOverlay = { replaced: overlay.replaced, added: overlay.added, total: overlay.catalog.length };
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
    settleWithoutSpaceTrack(false);
    return;
  }

  // ── Write ────────────────────────────────────────────────────────────────
  try {
    deps.writeCache(enriched);
  } catch (writeErr) {
    const message = (writeErr as Error)?.message ?? String(writeErr);
    logger.error(
      `Writing the catalog to disk failed (disk full or no permission?): ${message} — ` +
        'the previous cache keeps being served',
    );
    removeLeftoverCacheTempFiles();

    // The data came from a Space-Track login: that attempt failed, so the cap, the
    // backoff and the alert see it.
    const failedAt = attempt ? recordSpaceTrackFailure(attempt, deps.now()) : null;
    attempt = null;
    const dailyDue = failedAt !== null && dailyFailureAlertDue(failedAt);

    const today = utcDay(deps.now());
    if (dailyDue || !alertSentOn('writeFailure', today)) {
      // One alert covers both: when this was the day's last Space-Track attempt it also
      // stands in for the daily alert.
      if (dailyDue && failedAt) markDailyAlertSent(failedAt);
      markAlertSent('writeFailure', today);
      const diskLine = await deps.diskUsageLine().catch(() => null);
      const age = cacheAgeMs(deps.now());
      sendFireAndForget(
        deps,
        buildWriteFailureAlert({
          error: message,
          source,
          catalogAgeMs: age,
          hasCatalog: age !== null,
          diskLine,
          ...(failedAt ? { attemptsToday: failedAt.attemptsToday ?? 0 } : {}),
          dailyCapFailed: dailyDue,
        }),
      );
    }
    settleWithoutSpaceTrack(false);
    return;
  }

  // The Space-Track attempt counts as a success only once its data is on disk.
  // If anything above threw (parse bug, disk full), the pending record stays a
  // failure and the next login backs off instead of re-downloading at once.
  if (attempt) recordSpaceTrackSuccess(deps.now(), attempt);
  if (source === 'celestrak') {
    const today = utcDay(deps.now());
    if (!alertSentOn('celestrakFallback', today)) {
      markAlertSent('celestrakFallback', today);
      sendFireAndForget(deps, buildCelesTrakFallbackAlert({ spaceTrackProblem, overlay: lastOverlay }));
    }
  }
  if (source === 'space-track') {
    // Only a Space-Track success ends the retries. A CelesTrak write does not.
    cancelUpdateRetry();
  } else {
    settleWithoutSpaceTrack(true);
  }

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
 * The 02:00 cron run: the update cycle, then the once-a-day disk check (so a slow fill is
 * caught even when no archive write happens). Neither step can throw out of here.
 */
export async function runScheduledCycle(
  overrides: Partial<UpdateCycleDeps> = {},
  checkDisk: () => Promise<unknown> = () => reportDiskAndAlert('after 02:00 cycle'),
): Promise<void> {
  try {
    await runUpdateCycle('cron', overrides);
  } catch (err) {
    logger.error('Cron cycle error:', err);
  }
  try {
    await checkDisk();
  } catch (err) {
    logger.warn(`Daily disk check failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

/**
 * After a restart the retry timer is gone. If the attempt log shows an outage in
 * progress (the last Space-Track attempt did not succeed), arm the timer again for the
 * moment the gate allows a login, so a deploy in the middle of an outage does not
 * silently skip the day's remaining attempts. The gate still decides; this adds no
 * attempt of its own. Never throws.
 */
export function resumeSpaceTrackRetry(overrides: Partial<UpdateCycleDeps> = {}): void {
  try {
    const deps: UpdateCycleDeps = { ...defaultUpdateCycleDeps, ...overrides };
    if (!deps.spaceTrackConfigured()) return;
    const state = readAttemptState();
    if (!state || state.lastOutcome === 'success') return;
    const gate = evaluateGate(state, deps.now());
    armUpdateRetry(gate.allowed ? deps.now() : gate.retryAt, deps, overrides);
  } catch (err) {
    logger.warn(`Could not resume the Space-Track retry: ${(err as Error)?.message ?? String(err)}`);
  }
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
  } else {
    resumeSpaceTrackRetry();
  }

  const job = cron.schedule(CRON_SCHEDULE, () => {
    logger.info(`Cron triggered (${CRON_SCHEDULE})`);
    void runScheduledCycle();
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
