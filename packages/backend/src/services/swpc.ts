// ============================================================
// NOAA SWPC fetcher — daily geomagnetic + solar radio flux indices.
// Mirrors services/celestrak-visual.ts (retries, timeout, structured logging).
//
// Source (verified live 2026-09-09, no API key required):
//   - https://services.swpc.noaa.gov/text/daily-geomagnetic-indices.txt (DGD)
//     "Last 30 Days Daily Geomagnetic Data" — fixed-width text, one row/day:
//     Fredericksburg (A + 8x3h K), College (A + 8x3h K), Estimated Planetary
//     (A + 8x3h Kp). We read ONLY the trailing Estimated-Planetary group: the
//     Fredericksburg/College station columns splice missing readings in as a
//     bare "-1" with NO separating space on the row before/after them (e.g.
//     "...-1-1-1-1-1..."), which silently merges whitespace-split tokens.
//     The Planetary group is a computed estimate and never does this in
//     observed data, so taking the last 9 whitespace tokens (A + 8 Kp) is
//     reliable without a fixed-column parser.
//   - https://services.swpc.noaa.gov/text/daily-solar-indices.txt (DSD)
//     "Last 30 Days Daily Solar Data" — fixed-width text, one row/day; the
//     4th whitespace token is the observed 10.7cm radio flux (sfu).
//
// Both products carry only a 30-day trailing window (NOAA doesn't publish a
// JSON equivalent as of this writing — services.swpc.noaa.gov/json/ has
// hourly/minutely feeds like f107_cm_flux.json and planetary_k_index_1m.json,
// but no clean "one row per UTC day" JSON product). That 30-day window is a
// real limitation: geomagneticAp/geomagneticKp/solarFlux10cm resolve to null
// for any tMs older than ~30 days.
// ============================================================

import axios, { AxiosError } from 'axios';
import { logger } from '../utils/logger.js';
import type { SwpcDailyIndex } from '../types/index.js';

export type { SwpcDailyIndex } from '../types/index.js';

const DGD_URL = 'https://services.swpc.noaa.gov/text/daily-geomagnetic-indices.txt';
const DSD_URL = 'https://services.swpc.noaa.gov/text/daily-solar-indices.txt';

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string, label: string): Promise<string> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      logger.info(`SWPC ${label} fetch attempt ${attempt}/${RETRY_COUNT}`);
      const response = await axios.get<string>(url, {
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'text',
        transformResponse: (d) => d as string,
        decompress: true,
        headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'OrbitWatch/1.0' },
      });
      return response.data;
    } catch (err) {
      lastError = err;
      const status = (err as AxiosError).response?.status;
      logger.warn(`SWPC ${label} attempt ${attempt} failed (HTTP ${status ?? 'timeout/network'})`);
      if (attempt < RETRY_COUNT) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : 'unknown error';
  throw new Error(`SWPC ${label} fetch failed after ${RETRY_COUNT} attempts: ${detail}`);
}

/**
 * Parses one DGD.txt data row into {date, apIndex, kpIndex}, reading only the
 * trailing "Estimated Planetary" group (last 9 whitespace tokens: A-index
 * followed by 8 three-hourly Kp values). Returns null for header/comment/
 * blank lines or a row that doesn't parse cleanly.
 */
export function parseDgdLine(line: string): { date: string; apIndex: number; kpIndex: number } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(':')) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 12) return null;
  const [y, m, d] = tokens;
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null;

  const tail = tokens.slice(-9); // [planetaryA, kp0..kp7]
  const apIndex = Number(tail[0]);
  const kps = tail.slice(1).map(Number);
  if (!Number.isFinite(apIndex) || kps.length !== 8 || kps.some((v) => !Number.isFinite(v))) return null;

  const kpIndex = kps.reduce((a, b) => a + b, 0) / kps.length;
  return { date: `${y}-${m}-${d}`, apIndex, kpIndex };
}

/**
 * Parses one DSD.txt data row into {date, f107}. The radio flux is the first
 * data column after the Y/M/D date columns. Returns null for header/comment/
 * blank lines or a row that doesn't parse cleanly.
 */
export function parseDsdLine(line: string): { date: string; f107: number } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(':')) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 4) return null;
  const [y, m, d, fluxRaw] = tokens;
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null;

  const f107 = Number(fluxRaw);
  if (!Number.isFinite(f107)) return null;
  return { date: `${y}-${m}-${d}`, f107 };
}

/**
 * Fetches + merges the two NOAA SWPC daily text products into one date-keyed
 * array, sorted ascending by date. The two fetches are independent
 * (Promise.allSettled): if only one product fails, the other still
 * contributes partial records (the missing side reads as honest null rather
 * than failing the whole fetch). Throws only when BOTH fail.
 */
export async function fetchSwpcDailyIndices(): Promise<SwpcDailyIndex[]> {
  const [dgdResult, dsdResult] = await Promise.allSettled([
    fetchText(DGD_URL, 'daily-geomagnetic-indices'),
    fetchText(DSD_URL, 'daily-solar-indices'),
  ]);

  if (dgdResult.status === 'rejected' && dsdResult.status === 'rejected') {
    throw new Error(
      `SWPC fetch failed for both products: geomag=${(dgdResult.reason as Error).message}, ` +
        `solar=${(dsdResult.reason as Error).message}`,
    );
  }

  const byDate = new Map<string, SwpcDailyIndex>();
  function ensure(date: string): SwpcDailyIndex {
    let rec = byDate.get(date);
    if (!rec) {
      rec = { date, apIndex: null, kpIndex: null, f107: null };
      byDate.set(date, rec);
    }
    return rec;
  }

  if (dgdResult.status === 'fulfilled') {
    for (const line of dgdResult.value.split('\n')) {
      const parsed = parseDgdLine(line);
      if (!parsed) continue;
      const rec = ensure(parsed.date);
      rec.apIndex = parsed.apIndex;
      rec.kpIndex = parsed.kpIndex;
    }
  } else {
    logger.warn(`SWPC daily-geomagnetic-indices fetch failed: ${(dgdResult.reason as Error).message}`);
  }

  if (dsdResult.status === 'fulfilled') {
    for (const line of dsdResult.value.split('\n')) {
      const parsed = parseDsdLine(line);
      if (!parsed) continue;
      ensure(parsed.date).f107 = parsed.f107;
    }
  } else {
    logger.warn(`SWPC daily-solar-indices fetch failed: ${(dsdResult.reason as Error).message}`);
  }

  const records = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  logger.info(`SWPC: merged ${records.length} daily index records`);
  return records;
}
