import axios, { AxiosError } from 'axios';
import { SpaceTrackGPElement } from '../types/index.js';
import { logger } from '../utils/logger.js';

// ============================================================
// Space-Track service — PRIMARY data source
//
// Session lifecycle (one per fetch cycle, never left open):
//   1. POST /ajaxauth/login          → receive session cookie
//   2. GET  GP query (paginated)     → all current orbital objects
//   3. GET  /ajaxauth/logout         → always, even on error (finally block)
//
// NOTE: we deliberately DO NOT fetch the SATCAT class. Space-Track's satcat no
// longer exposes OPS_STATUS_CODE (the field is absent from the response), so it
// gave us nothing — object type comes from the GP class (OBJECT_TYPE) and orbital
// status comes from the checked-in McDowell satcat.csv (see enrichment/).
//
// Request budget per 24h cycle:
//   1 login + 1–3 GP pages + 1 logout ≈ 3–5 requests
//   Space-Track allows ~30/day — we stay well under that.
//
// Credentials are read from environment variables:
//   SPACETRACK_USER, SPACETRACK_PASS
// Register free at https://www.space-track.org/auth/createAccount
// ============================================================

const BASE_URL = 'https://www.space-track.org';
const LOGIN_URL  = `${BASE_URL}/ajaxauth/login`;
const LOGOUT_URL = `${BASE_URL}/ajaxauth/logout`;

// GP query — all objects with no decay date and TLE epoch within last 30 days.
// %3E = ">", so EPOCH/%3Enow-30 means "epoch > (now − 30 days)".
// emptyresult/show ensures a [] response instead of an error on no results.
const GP_BASE =
  `${BASE_URL}/basicspacedata/query/class/gp` +
  `/DECAY_DATE/null-val` +
  `/EPOCH/%3Enow-30` +
  `/orderby/NORAD_CAT_ID%20asc` +
  `/format/json/emptyresult/show`;

// Space-Track's max rows per request. Staying at 25 000 is safe and well-tested.
const PAGE_SIZE = 25_000;

// Generous timeout — a full GP page (25k objects) is a multi-MB response.
const TIMEOUT_MS = 120_000;

// ============================================================
// Internal session helpers
// ============================================================

/**
 * Authenticate and return the session cookie string.
 * The cookie must be included in every subsequent request header.
 * Throws if credentials are wrong or the server is unreachable.
 */
async function login(): Promise<string> {
  const user = process.env.SPACETRACK_USER;
  const pass = process.env.SPACETRACK_PASS;

  if (!user || !pass) {
    throw new Error(
      'SPACETRACK_USER and SPACETRACK_PASS environment variables are not set. ' +
      'Register at https://www.space-track.org/auth/createAccount',
    );
  }

  logger.info('Space-Track: logging in');

  // Space-Track expects form-encoded credentials, not JSON.
  // The response sets a session cookie (typically named "chocolatechip").
  const resp = await axios.post(
    LOGIN_URL,
    `identity=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`,
    {
      timeout: TIMEOUT_MS,
      // Allow redirects — Space-Track sometimes redirects to / on success.
      maxRedirects: 5,
      validateStatus: (s) => s < 500,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  );

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Space-Track login rejected (HTTP ${resp.status}) — check credentials`);
  }

  // Collect the Set-Cookie header values (there may be multiple cookies).
  const raw: string[] | undefined = resp.headers['set-cookie'];
  if (!raw || raw.length === 0) {
    throw new Error('Space-Track login: no session cookie in response');
  }

  // Strip path/expires/httponly flags — keep only name=value pairs.
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  logger.info('Space-Track: login successful');
  return cookie;
}

/**
 * Invalidate the session. Always call this when the fetch cycle ends,
 * whether it succeeded or failed.
 */
async function logout(cookie: string): Promise<void> {
  try {
    await axios.get(LOGOUT_URL, {
      timeout: 15_000,
      headers: { Cookie: cookie },
      validateStatus: () => true, // never throw on status — we're cleaning up
    });
    logger.info('Space-Track: logged out');
  } catch (err) {
    // Non-critical — session will expire on its own (~2h inactivity).
    logger.warn('Space-Track: logout request failed (session will expire naturally):', (err as Error).message);
  }
}

/**
 * Fetch one page of GP elements.
 * Returns an empty array when the offset is beyond the last record.
 */
async function fetchGPPage(
  cookie: string,
  offset: number,
): Promise<SpaceTrackGPElement[]> {
  const url = `${GP_BASE}/limit/${PAGE_SIZE},${offset}`;
  logger.info(`Space-Track: fetching GP page offset=${offset}`);

  const resp = await axios.get<SpaceTrackGPElement[]>(url, {
    timeout: TIMEOUT_MS,
    decompress: true,
    headers: { Cookie: cookie, 'Accept-Encoding': 'gzip' },
    validateStatus: (s) => s < 500,
  });

  if (resp.status === 401) {
    throw new Error('Space-Track GP fetch: session expired or invalid (HTTP 401)');
  }
  if (resp.status !== 200) {
    throw new Error(`Space-Track GP fetch failed: HTTP ${resp.status}`);
  }

  // Guard against Space-Track returning an HTML error page instead of JSON.
  if (!Array.isArray(resp.data)) {
    throw new Error('Space-Track GP fetch: unexpected non-array response (HTML error page?)');
  }

  logger.info(`Space-Track: GP page offset=${offset} → ${resp.data.length} records`);
  return resp.data;
}

/**
 * Fetch all GP elements using pagination.
 * Keeps requesting pages until a page comes back smaller than PAGE_SIZE
 * (which signals the last page).
 */
async function fetchAllGP(cookie: string): Promise<SpaceTrackGPElement[]> {
  const all: SpaceTrackGPElement[] = [];
  let offset = 0;

  while (true) {
    const page = await fetchGPPage(cookie, offset);
    all.push(...page);

    // If this page is smaller than PAGE_SIZE, we've reached the last page.
    if (page.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
  }

  logger.info(`Space-Track: GP fetch complete — ${all.length} total records`);
  return all;
}

// ============================================================
// Public API
// ============================================================

export interface SpaceTrackFetchResult {
  gp: SpaceTrackGPElement[];
}

/**
 * Run a full Space-Track fetch cycle:
 *   login → fetch all GP (paginated) → logout
 *
 * The session is ALWAYS closed in the finally block regardless of errors.
 * Throws on failure so the caller (tle-updater) can fall back to CelesTrak.
 */
export async function fetchFromSpaceTrack(): Promise<SpaceTrackFetchResult> {
  if (!process.env.SPACETRACK_USER || !process.env.SPACETRACK_PASS) {
    throw new Error('Space-Track credentials not configured');
  }

  let cookie: string | null = null;

  try {
    cookie = await login();
    const gp = await fetchAllGP(cookie);
    return { gp };
  } finally {
    // Always logout — never leave a session open.
    if (cookie) {
      await logout(cookie);
    }
  }
}
