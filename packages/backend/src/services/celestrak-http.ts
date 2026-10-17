import axios, { AxiosError } from 'axios';
import { logger } from '../utils/logger.js';
import {
  beginCelesTrakAttempt,
  checkCelesTrakGate,
  describeSkippedCelesTrak,
  recordCelesTrakFailure,
  recordCelesTrakSuccess,
} from '../cache/celestrak-attempts.js';

// ============================================================
// One GET against CelesTrak with the calling rules from its usage policy:
//   - a 4xx answer (403 "not updated since your last download", 404, ...) is final:
//     throw at once, never retry. Repeating can get the IP firewalled.
//   - timeouts, network errors and 5xx are retried, at most `retryCount` tries.
// ============================================================

/** Thrown for a 4xx answer. Carries the status so callers can log or store it. */
export class CelesTrakHttpError extends Error {
  readonly httpStatus: number;
  constructor(label: string, httpStatus: number) {
    super(
      `${label}: CelesTrak answered HTTP ${httpStatus} — not retrying ` +
        `(repeating after a 4xx can get the IP blocked; CelesTrak data updates only every 2 hours)`,
    );
    this.name = 'CelesTrakHttpError';
    this.httpStatus = httpStatus;
  }
}

export interface CelesTrakGetOptions {
  /** Used in log lines and error messages, for example 'CelesTrak'. */
  label: string;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HTTP status of the last failed try, if the final error was an HTTP answer. */
export function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof CelesTrakHttpError) return err.httpStatus;
  return (err as AxiosError | undefined)?.response?.status;
}

export async function celesTrakGet<T>(url: string, opts: CelesTrakGetOptions): Promise<T> {
  let lastDetail = 'unknown error';

  for (let attempt = 1; attempt <= opts.retryCount; attempt++) {
    try {
      logger.info(`${opts.label} fetch attempt ${attempt}/${opts.retryCount}`);
      const response = await axios.get<T>(url, {
        timeout: opts.timeoutMs,
        decompress: true,
        headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'OrbitWatch/1.0' },
      });
      return response.data;
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      if (status !== undefined && status >= 400 && status < 500) {
        logger.warn(`${opts.label} attempt ${attempt} failed (HTTP ${status}) — not retrying`);
        throw new CelesTrakHttpError(opts.label, status);
      }
      lastDetail = status !== undefined ? `HTTP ${status}` : 'timeout/network error';
      logger.warn(`${opts.label} attempt ${attempt} failed (${lastDetail})`);
      if (attempt < opts.retryCount) await sleep(opts.retryDelayMs);
    }
  }

  throw new Error(`${opts.label} fetch failed after ${opts.retryCount} attempts (last: ${lastDetail})`);
}

/** The 2 hour politeness gate said no: nothing was requested. Not a CelesTrak failure. */
export class CelesTrakSkippedError extends Error {
  readonly retryAt: number;
  constructor(message: string, retryAt: number) {
    super(message);
    this.name = 'CelesTrakSkippedError';
    this.retryAt = retryAt;
  }
}

/**
 * celesTrakGet behind the persisted 2 hour gate (cache/celestrak-attempts.ts).
 * The attempt is written before the request and settled after it. When the gate
 * is closed, nothing is requested and CelesTrakSkippedError is thrown.
 */
export async function gatedCelesTrakGet<T>(
  group: string,
  url: string,
  opts: CelesTrakGetOptions,
  now: () => number = Date.now,
): Promise<T> {
  const gate = checkCelesTrakGate(group, now());
  if (!gate.allowed) {
    throw new CelesTrakSkippedError(describeSkippedCelesTrak(group, gate.retryAt, now()), gate.retryAt);
  }

  beginCelesTrakAttempt(group, now());
  try {
    const data = await celesTrakGet<T>(url, opts);
    recordCelesTrakSuccess(group, now());
    return data;
  } catch (err) {
    recordCelesTrakFailure(group, now(), httpStatusOf(err));
    throw err;
  }
}
