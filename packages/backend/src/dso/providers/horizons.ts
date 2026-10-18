import axios, { AxiosError } from 'axios';
import type { DsoRegistryEntry } from '../registry/index.js';
import type {
  DsoProviderAdapter,
  ProviderFetchResult,
  ProviderSample,
} from './types.js';
import { logger } from '../../utils/logger.js';
import {
  extractCoverageBoundsFromError,
  isEphemerisEndedInPast,
  mergeCoverageBounds,
  planCoverageRetry,
  type HorizonsCoverageBounds,
  type HorizonsRequestWindow,
} from './horizons-coverage.js';
import { DsoEphemerisEndedError } from './ended-error.js';

const HORIZONS_API_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const REQUEST_TIMEOUT_MS = 30_000;

interface HorizonsApiResponse {
  result?: string;
  error?: string;
  signature?: {
    version?: string;
    source?: string;
  };
}

export class HorizonsNetworkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'HorizonsNetworkError';
  }
}

export class HorizonsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HorizonsParseError';
  }
}

export class HorizonsThrottleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HorizonsThrottleError';
  }
}

export class HorizonsObjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HorizonsObjectNotFoundError';
  }
}

let horizonsRequestQueue: Promise<void> = Promise.resolve();

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const run = horizonsRequestQueue.catch(() => undefined).then(task);
  horizonsRequestQueue = run.then(() => undefined, () => undefined);
  return run;
}

function quote(value: string): string {
  return `'${value}'`;
}

function formatHorizonsTime(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function formatStepSize(stepSeconds: number): string {
  if (stepSeconds <= 0 || !Number.isFinite(stepSeconds)) {
    throw new HorizonsParseError(`Invalid step size: ${stepSeconds}`);
  }
  if (stepSeconds % 60 === 0) {
    return `${stepSeconds / 60} m`;
  }
  return `${stepSeconds} s`;
}

function classifyApiError(message: string): Error {
  if (/too many|rate limit|busy|temporarily unavailable|try again/i.test(message)) {
    return new HorizonsThrottleError(message);
  }
  if (
    /no matches found|cannot interpret|unknown target|not found|multiple matches|no ephemeris|ambiguous target|outside.*range/i.test(
      message,
    )
  ) {
    return new HorizonsObjectNotFoundError(message);
  }
  return new HorizonsParseError(message);
}

function toIsoCalendarDateTdb(calendarDateRaw: string): string {
  const match = calendarDateRaw.match(
    /^A\.D\.\s+(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/,
  );
  if (!match) {
    throw new HorizonsParseError(`Unexpected Horizons calendar date format: ${calendarDateRaw}`);
  }

  const [, year, monthToken, day, time] = match;
  const normalizedMonthToken = `${monthToken[0].toUpperCase()}${monthToken.slice(1).toLowerCase()}`;
  const month = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12',
  }[normalizedMonthToken];

  if (!month) {
    throw new HorizonsParseError(`Unexpected Horizons month token: ${monthToken}`);
  }

  return `${year}-${month}-${day}T${time}`;
}

function formatWindowRange(windowStart: Date, windowEnd: Date): string {
  return `${windowStart.toISOString()}..${windowEnd.toISOString()}`;
}

function extractApiErrorMessage(data: unknown): string | null {
  if (typeof data === 'string') {
    const message = data.trim();
    return message.length > 0 ? message : null;
  }

  if (data && typeof data === 'object') {
    const maybeError = 'error' in data ? data.error : undefined;
    if (typeof maybeError === 'string' && maybeError.trim().length > 0) {
      return maybeError.trim();
    }
  }

  return null;
}

function extractEmbeddedResultError(result: string): string | null {
  const trimmed = result.trim();
  if (
    /no matches found|cannot interpret|unknown target|not found|multiple matches|no ephemeris|ambiguous target|outside.*range|server busy|temporarily unavailable/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return null;
}

function parseCsvVectorLine(line: string): ProviderSample {
  const parts = line
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 8) {
    throw new HorizonsParseError(`Unexpected Horizons vector row shape: ${line}`);
  }

  const [
    julianDayRaw,
    calendarDateRaw,
    xRaw,
    yRaw,
    zRaw,
    vxRaw,
    vyRaw,
    vzRaw,
  ] = parts;

  const julianDayTdb = Number.parseFloat(julianDayRaw);
  const x = Number.parseFloat(xRaw);
  const y = Number.parseFloat(yRaw);
  const z = Number.parseFloat(zRaw);
  const vx = Number.parseFloat(vxRaw);
  const vy = Number.parseFloat(vyRaw);
  const vz = Number.parseFloat(vzRaw);

  if ([julianDayTdb, x, y, z, vx, vy, vz].some((value) => !Number.isFinite(value))) {
    throw new HorizonsParseError(`Non-numeric Horizons vector row: ${line}`);
  }

  return {
    julianDayTdb,
    calendarTimestampTdb: toIsoCalendarDateTdb(calendarDateRaw),
    x,
    y,
    z,
    vx,
    vy,
    vz,
  };
}

function parseHorizonsResult(result: string): ProviderSample[] {
  if (!/Reference frame\s*:\s*ICRF/i.test(result)) {
    throw new HorizonsParseError('Horizons did not return ICRF/FRAME vectors');
  }

  const ephemerisBlock = result.match(/\$\$SOE\s*([\s\S]*?)\s*\$\$EOE/);
  if (!ephemerisBlock) {
    throw new HorizonsParseError('Horizons response is missing $$SOE/$$EOE vector data');
  }

  const rows = ephemerisBlock[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rows.length === 0) {
    throw new HorizonsParseError('Horizons response returned no vector rows');
  }

  return rows.map(parseCsvVectorLine);
}

async function requestHorizons(
  entry: DsoRegistryEntry,
  windowStart: Date,
  windowEnd: Date,
): Promise<ProviderFetchResult> {
  const fetchedAt = new Date().toISOString();

  try {
    const response = await axios.get<HorizonsApiResponse>(HORIZONS_API_URL, {
      timeout: REQUEST_TIMEOUT_MS,
      params: {
        format: 'json',
        COMMAND: quote(entry.providerObjectId),
        OBJ_DATA: quote('NO'),
        MAKE_EPHEM: quote('YES'),
        EPHEM_TYPE: quote('VECTORS'),
        CENTER: quote('500@399'),
        START_TIME: quote(formatHorizonsTime(windowStart)),
        STOP_TIME: quote(formatHorizonsTime(windowEnd)),
        STEP_SIZE: quote(formatStepSize(entry.sampleStepSec)),
        REF_SYSTEM: quote('ICRF'),
        REF_PLANE: quote('FRAME'),
        OUT_UNITS: quote('KM-S'),
        VEC_TABLE: quote('2'),
        VEC_CORR: quote('NONE'),
        CSV_FORMAT: quote('YES'),
        TIME_DIGITS: quote('FRACSEC'),
        TIME_TYPE: quote('TDB'),
      },
    });

    const payload = response.data;
    const apiError = extractApiErrorMessage(payload);
    if (apiError) {
      throw classifyApiError(apiError);
    }

    const result = typeof payload.result === 'string' ? payload.result : '';
    if (!result) {
      throw new HorizonsParseError('Horizons response did not contain a result payload');
    }

    const embeddedError = extractEmbeddedResultError(result);
    if (embeddedError) {
      throw classifyApiError(embeddedError);
    }

    const samples = parseHorizonsResult(result);

    logger.info(
      `Horizons fetch succeeded for ${entry.dsoId} (${entry.providerObjectId}) with ${samples.length} samples`,
    );

    return {
      provider: entry.provider,
      providerObjectId: entry.providerObjectId,
      sourceFrame: 'ICRF',
      sourceUnits: 'KM-S',
      timeScale: 'TDB',
      fetchedAt,
      sourceRevisionAt: null,
      samples,
    };
  } catch (error) {
    if (
      error instanceof HorizonsParseError ||
      error instanceof HorizonsThrottleError ||
      error instanceof HorizonsObjectNotFoundError
    ) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<HorizonsApiResponse>;
      const status = axiosError.response?.status;
      const apiMessage = extractApiErrorMessage(axiosError.response?.data);

      if (status === 429 || status === 503) {
        throw new HorizonsThrottleError(
          apiMessage || `Horizons throttled request with HTTP ${status}`,
        );
      }

      if (apiMessage) {
        throw classifyApiError(apiMessage);
      }

      throw new HorizonsNetworkError(
        `Horizons request failed (${status ?? 'network/timeout'})`,
        error,
      );
    }

    throw new HorizonsNetworkError('Unexpected Horizons request failure', error);
  }
}

/** One request to Horizons for an exact window. Injected in tests. */
export type HorizonsRequestFn = (
  entry: DsoRegistryEntry,
  windowStart: Date,
  windowEnd: Date,
) => Promise<ProviderFetchResult>;

// Horizons reports one bound per error, so a window that is wrong at both ends
// needs two clamps: first request fails ("prior to"), retry 1 fails ("after"),
// retry 2 asks for the intersection. Never more than 3 requests per refresh.
const MAX_CLAMP_RETRIES = 2;

function windowsEqual(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() === bStart.getTime() && aEnd.getTime() === bEnd.getTime();
}

/**
 * Ask Horizons for a window; when it answers "no ephemeris prior to / after ...",
 * read the bounds, clamp the window to what exists and ask again (at most
 * MAX_CLAMP_RETRIES times, and never for a window already tried).
 *
 *  - Data ends in the past (more than a day ago): a successful clamped fetch comes
 *    back with `coverageEndedAt`; a failed or empty one throws DsoEphemerisEndedError.
 *    Either way the worker learns the mission is over and stops asking.
 *  - Anything else that fails (network, throttle, parse errors, unknown target,
 *    data that has not started yet) is rethrown as it always was: transient, retried
 *    later by the normal backoff.
 */
export async function requestWithCoverageClamp(
  entry: DsoRegistryEntry,
  windowStart: Date,
  windowEnd: Date,
  request: HorizonsRequestFn = requestHorizons,
  now: Date = new Date(),
): Promise<ProviderFetchResult> {
  let currentStart = windowStart;
  let currentEnd = windowEnd;
  let retries = 0;
  let bounds: HorizonsCoverageBounds = { earliestAvailable: null, latestAvailable: null };

  const requested = `requestedWindow=${formatWindowRange(windowStart, windowEnd)}`;
  const endedError = (reason: string): DsoEphemerisEndedError => {
    const endedAt = bounds.latestAvailable as Date;
    return new DsoEphemerisEndedError(
      `Horizons ephemeris for ${entry.dsoId} ended ${endedAt.toISOString()} (${reason}; ${requested})`,
      endedAt,
    );
  };

  for (;;) {
    try {
      const result = await request(entry, currentStart, currentEnd);
      if (retries > 0 && isEphemerisEndedInPast(bounds, now)) {
        return { ...result, coverageEndedAt: (bounds.latestAvailable as Date).toISOString() };
      }
      return result;
    } catch (error) {
      if (!(error instanceof HorizonsObjectNotFoundError)) {
        throw error;
      }

      const found = extractCoverageBoundsFromError(error.message);
      if (!found || (!found.earliestAvailable && !found.latestAvailable)) {
        throw new HorizonsObjectNotFoundError(
          `${error.message} (${requested}; no valid clamped retry window)`,
        );
      }
      bounds = mergeCoverageBounds(bounds, found);

      const plan = planCoverageRetry(entry, windowStart, windowEnd, bounds, now);
      if (plan.action === 'ended') {
        throw endedError('no data inside the requested window');
      }

      const canRetry =
        plan.action === 'retry' &&
        retries < MAX_CLAMP_RETRIES &&
        !windowsEqual(plan.window.windowStart, plan.window.windowEnd, currentStart, currentEnd);

      if (!canRetry) {
        if (isEphemerisEndedInPast(bounds, now)) {
          throw endedError('clamped window could not be fetched');
        }
        const tried =
          retries > 0 ? ` clampedWindow=${formatWindowRange(currentStart, currentEnd)}` : '';
        throw new HorizonsObjectNotFoundError(
          `${error.message} (${requested}${tried}; no valid clamped retry window)`,
        );
      }

      const window = (plan as { action: 'retry'; window: HorizonsRequestWindow }).window;
      logger.warn(
        `Horizons range clamp retry for ${entry.dsoId}: ${requested} clampedWindow=${formatWindowRange(window.windowStart, window.windowEnd)}`,
      );
      currentStart = window.windowStart;
      currentEnd = window.windowEnd;
      retries += 1;
    }
  }
}

export class HorizonsProvider implements DsoProviderAdapter {
  async fetchEphemeris(
    entry: DsoRegistryEntry,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ProviderFetchResult> {
    return runSerialized(() => requestWithCoverageClamp(entry, windowStart, windowEnd));
  }
}
