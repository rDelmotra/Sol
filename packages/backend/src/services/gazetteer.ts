// ============================================================
// Place-name gazetteer — grounds "visible from <city>"-style questions in a
// real, sourced dataset instead of letting the compiler LLM recall coordinates
// from its own memory (measured defect: three independent compile samples of
// the same question disagreed with each other AND with the reference for
// Sydney/Tokyo longitude — see the analytic-compiler.ts caller for how the
// resolved line is injected into the user turn).
//
// Source: Natural Earth 1:10m populated places (public domain, no API key)
//   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson
// Confirmed characteristics (verified against a live fetch):
//   - Plain GeoJSON FeatureCollection, ~4.9 MB, 7,342 Point features.
//   - The endpoint is SLOW (~90s observed) — REQUEST_TIMEOUT_MS is generous
//     and the fetch retries; this only matters for the first place-mentioning
//     request in a process's lifetime (see loadFromNetworkOrCache below) —
//     everything after that is served from the in-memory index or the 30-day
//     file cache (cache/gazetteer-cache.ts).
//   - Coordinates live at feature.geometry.coordinates as [lon, lat] — GeoJSON
//     order. There are ALSO redundant feature.properties.latitude/longitude
//     fields, but they are label-placement offsets and can disagree with the
//     geometry (e.g. Sydney AU: geometry lon 151.212548 vs properties
//     longitude 151.183234) — geometry.coordinates is the source of truth
//     here, matching the reference values this feature was built against.
//   - Alternate/historic names live in namepar/ls_name/meganame, NOT namealt
//     (only 544/7342 features have namealt at all). Bengaluru's alt name
//     "Bangalore" is in namepar (and duplicated into ls_name/meganame) —
//     indexing name alone misses it entirely, so all five fields are indexed.
//   - 188 names are ambiguous (worst: Springfield x5, Victoria x5). Sydney has
//     two entries — Australia (pop_max 4,630,000) and Nova Scotia, Canada
//     (pop_max 37,538) — resolved by picking the higher pop_max and reporting
//     the runner-up (never silently disambiguating).
//   - A couple of records carry pop_max === -99 (Natural Earth's "unknown"
//     sentinel); it is passed straight through and simply never wins a
//     population-ordered tie against a real city.
//
// Fail-soft contract: a fetch failure, an empty/unreadable cache, or the
// gazetteer never having been asked to load all degrade to resolvePlace()
// returning null. Nothing in this module throws out of resolvePlace/
// extractPlaceCandidates/getVersion — a gazetteer outage must never break the
// ask/compile path (see analytic-compiler.ts).
// ============================================================

import axios, { AxiosError } from 'axios';
import { logger } from '../utils/logger.js';
import {
  isGazetteerCacheFresh,
  readGazetteerCache,
  writeGazetteerCache,
  type GazetteerCache,
} from '../cache/gazetteer-cache.js';

const GAZETTEER_SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson';

// The source is confirmed slow (~90s observed) — generous timeout per spec.
const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 3_000;

// ── Public types ──────────────────────────────────────────────────────────────

/** One place record extracted from the source GeoJSON — only the fields the
 *  resolver needs, not the full upstream properties bag. */
export interface GazetteerSourceRecord {
  /** Canonical display name (feature.properties.name, falling back to nameascii). */
  name: string;
  nameAscii: string | null;
  nameAlt: string | null;
  lsName: string | null;
  megaName: string | null;
  namePar: string | null;
  adm0Name: string | null;
  adm1Name: string | null;
  popMax: number | null;
  /** feature.geometry.coordinates[0] — GeoJSON [lon, lat] order. Do not swap. */
  lonDeg: number;
  /** feature.geometry.coordinates[1]. */
  latDeg: number;
  /** Stable per-record id: `ne:<ne_id>` when the source provides one, else a
   *  positional fallback (`ne:<index>:<name>`) so dedup by id still works. */
  sourceId: string;
}

export interface GazetteerAmbiguousMatch {
  name: string;
  countryName: string | null;
  admin1: string | null;
  population: number | null;
}

export interface GazetteerHit {
  /** The resolved record's canonical name (NOT necessarily the query text —
   *  e.g. resolvePlace('Bangalore') returns name: 'Bengaluru'). */
  name: string;
  latDeg: number;
  lonDeg: number;
  countryName: string | null;
  admin1: string | null;
  population: number | null;
  sourceId: string;
  /** Present iff the query matched more than one record. The runner-up by
   *  population — resolvePlace never silently disambiguates. */
  ambiguousWith?: GazetteerAmbiguousMatch;
}

export interface Gazetteer {
  /** Idempotent, memoized load (network-or-cache). Resolves once the index is
   *  ready to answer resolvePlace() — never rejects (fail-soft: an unrecoverable
   *  load failure resolves to an empty index, not a thrown error). */
  ensureReady(): Promise<void>;
  /** Synchronous lookup against whatever is currently indexed. Null before
   *  ensureReady() has completed, on a genuine miss, or if the gazetteer
   *  never managed to load any data. */
  resolvePlace(name: string): GazetteerHit | null;
  /** A stable marker for the currently-loaded state: the source cache's ISO
   *  version timestamp once loaded, 'unavailable' if loading completed but
   *  produced no usable data, or 'unloaded' if ensureReady() has never been
   *  called/completed. Folded into the compiler's cache key so a grounded and
   *  an ungrounded compile of the same question can never collide. */
  getVersion(): string;
}

// ── Name normalization (case + punctuation + accents) ─────────────────────────

function normalizeKey(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics (e.g. é -> e)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // punctuation/symbols → space
    .trim()
    .replace(/\s+/g, ' ');
}

// ── extractPlaceCandidates ──────────────────────────────────────────────────
//
// The main risk here is false positives: "Mobile", "Reading", "Nice",
// "Victoria" are all real Natural Earth cities AND common English words. The
// guard is a conjunction, not any single check:
//   1. Must immediately follow a locative trigger word (over/from/above/near/
//      in/at/for/around) — no gap.
//   2. The candidate (and every word it grows to include) must start with an
//      uppercase letter — an all-lowercase mention ("over the pacific") never
//      becomes a candidate at all.
//   3. The word immediately after the trigger must not be on the stopword
//      list (the/a/an/this/now/here/...) even if it happens to be capitalized
//      (e.g. sentence-medial "from The ...").
//   4. Multi-word candidates (up to 3 words) only grow while every additional
//      word is ALSO capitalized — "Sydney right now" stops after "Sydney"
//      because "right" isn't capitalized, so only "Sydney" is emitted.
//
// This deliberately over-generates a little (e.g. both "Los" and "Los
// Angeles" may be emitted from one trigger) rather than under-generate —
// resolvePlace is the real filter, and unresolved candidates feed the gap log
// so the true miss rate is measurable (see analytic-compiler.ts).

const LOCATIVE_TRIGGERS = new Set(['over', 'from', 'above', 'near', 'in', 'at', 'for', 'around']);

// English filler/function words only — deliberately NOT including foreign
// place-name-leading articles (la/le/los/las: "La Paz", "Los Angeles", "Las
// Vegas", "Le Havre" are real, legitimate Natural Earth entries).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'my', 'your', 'our', 'their', 'his', 'her', 'its',
  'i', 'we', 'you', 'he', 'she', 'it', 'they', 'us', 'them', 'me', 'him',
  'now', 'today', 'tonight', 'tomorrow', 'yesterday',
  'here', 'there', 'home', 'ground', 'sight', 'view', 'reach', 'hand',
  'which', 'what', 'all', 'any', 'some', 'no', 'not',
]);

const MAX_CANDIDATE_WORDS = 3;

interface Token {
  raw: string;
  lower: string;
  /** Letters/apostrophe/hyphen only — a bare number or symbol run is not a word. */
  isWord: boolean;
}

/** Splits on whitespace, then strips leading/trailing punctuation from each
 *  chunk while KEEPING non-word chunks (e.g. "45") in the sequence as
 *  isWord:false placeholders — dropping them entirely would wrongly make
 *  "at 45 degrees north" look like "at" is immediately followed by "degrees". */
function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const raw = chunk.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      return { raw, lower: raw.toLowerCase(), isWord: raw.length > 0 && /^[\p{L}'-]+$/u.test(raw) };
    })
    .filter((t) => t.raw.length > 0);
}

function isCapitalized(word: string): boolean {
  return /^\p{Lu}/u.test(word);
}

/** Finds candidate place mentions in a question: n-grams (1-3 words) that
 *  immediately follow a locative trigger, are Title-Case in the original
 *  text, and don't start with a stopword. Pure text extraction — no
 *  gazetteer lookup, no network, deterministic. */
export function extractPlaceCandidates(question: string): string[] {
  const tokens = tokenize(question);
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const trigger = tokens[i];
    if (!trigger.isWord || !LOCATIVE_TRIGGERS.has(trigger.lower)) continue;

    const startIdx = i + 1;
    const anchor = tokens[startIdx];
    if (!anchor || !anchor.isWord) continue;
    if (STOPWORDS.has(anchor.lower)) continue;
    if (!isCapitalized(anchor.raw)) continue; // false-positive guard: all-lowercase mentions never qualify

    const words: string[] = [];
    for (let n = 0; n < MAX_CANDIDATE_WORDS; n++) {
      const tok = tokens[startIdx + n];
      if (!tok || !tok.isWord || !isCapitalized(tok.raw)) break;
      words.push(tok.raw);
      const candidate = words.join(' ');
      if (candidate.toLowerCase() === candidate) continue; // defensive; unreachable given the capitalization gate above
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  return candidates;
}

// ── GeoJSON → GazetteerSourceRecord ────────────────────────────────────────

interface NeFeature {
  type?: string;
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
}
interface NeFeatureCollection {
  type?: string;
  features?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** Pure parse: raw GeoJSON (already JSON.parse'd) → the minimal record shape
 *  the index needs. Exported so tests can exercise the [lon,lat] order and
 *  alt-name mapping against a small inline fixture without any network I/O. */
export function parseGazetteerGeoJson(raw: unknown): GazetteerSourceRecord[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as NeFeatureCollection).features)) {
    throw new Error('gazetteer source is not a GeoJSON FeatureCollection');
  }

  const records: GazetteerSourceRecord[] = [];
  const features = (raw as NeFeatureCollection).features as unknown[];

  features.forEach((rawFeature, i) => {
    const f = rawFeature as NeFeature;
    const props = f.properties ?? {};
    const name = str(props.name) ?? str(props.nameascii);
    const coords = f.geometry?.coordinates;
    if (!name || !Array.isArray(coords) || coords.length < 2) return; // skip malformed feature

    // GeoJSON coordinate order is [lon, lat] — coords[0] is longitude.
    const lonDeg = Number(coords[0]);
    const latDeg = Number(coords[1]);
    if (!Number.isFinite(lonDeg) || !Number.isFinite(latDeg)) return;

    const popRaw = props.pop_max;
    const popMax = typeof popRaw === 'number' && Number.isFinite(popRaw) ? popRaw : null;
    const neId = str(props.ne_id);
    const sourceId = neId ? `ne:${neId}` : `ne:${i}:${name}`;

    records.push({
      name,
      nameAscii: str(props.nameascii),
      nameAlt: str(props.namealt),
      lsName: str(props.ls_name),
      megaName: str(props.meganame),
      namePar: str(props.namepar),
      adm0Name: str(props.adm0name),
      adm1Name: str(props.adm1name),
      popMax,
      lonDeg,
      latDeg,
      sourceId,
    });
  });

  return records;
}

// ── Index + resolve ────────────────────────────────────────────────────────

/** Every alias a record should be reachable by, deduped per-record — a
 *  feature whose ls_name/meganame/namepar all equal "Bangalore" contributes
 *  ONE "bangalore" bucket entry, not three (which would otherwise make the
 *  record falsely "ambiguous with itself"). */
function aliasesFor(rec: GazetteerSourceRecord): string[] {
  const raw = [rec.name, rec.nameAscii, rec.nameAlt, rec.lsName, rec.megaName, rec.namePar];
  const out = new Set<string>();
  for (const a of raw) {
    if (!a) continue;
    const key = normalizeKey(a);
    if (key) out.add(key);
  }
  return Array.from(out);
}

function buildIndex(records: GazetteerSourceRecord[]): Map<string, GazetteerSourceRecord[]> {
  const index = new Map<string, GazetteerSourceRecord[]>();
  for (const rec of records) {
    for (const alias of aliasesFor(rec)) {
      const bucket = index.get(alias);
      if (bucket) bucket.push(rec);
      else index.set(alias, [rec]);
    }
  }
  return index;
}

/** -99 is Natural Earth's "unknown population" sentinel; treating a missing/
 *  non-finite value as -Infinity means it can never win a population-ordered
 *  tie against a real city, without inventing a value that isn't measured. */
function popRank(rec: GazetteerSourceRecord): number {
  return typeof rec.popMax === 'number' && Number.isFinite(rec.popMax) ? rec.popMax : -Infinity;
}

function toHit(rec: GazetteerSourceRecord): Omit<GazetteerHit, 'ambiguousWith'> {
  return {
    name: rec.name,
    latDeg: rec.latDeg,
    lonDeg: rec.lonDeg,
    countryName: rec.adm0Name,
    admin1: rec.adm1Name,
    population: rec.popMax,
    sourceId: rec.sourceId,
  };
}

function toAmbiguousMatch(rec: GazetteerSourceRecord): GazetteerAmbiguousMatch {
  return { name: rec.name, countryName: rec.adm0Name, admin1: rec.adm1Name, population: rec.popMax };
}

function resolveAgainst(index: Map<string, GazetteerSourceRecord[]>, name: string): GazetteerHit | null {
  const key = normalizeKey(name);
  if (!key) return null;
  const bucket = index.get(key);
  if (!bucket || bucket.length === 0) return null;
  if (bucket.length === 1) return toHit(bucket[0]);

  // Ambiguous: highest pop_max wins, runner-up always reported (never a silent pick).
  const sorted = [...bucket].sort((a, b) => popRank(b) - popRank(a));
  return { ...toHit(sorted[0]), ambiguousWith: toAmbiguousMatch(sorted[1]) };
}

/** Builds a ready-to-use Gazetteer directly from records (no I/O) — the
 *  primitive both the real network/cache-backed loader and tests use. */
export function createGazetteerFromRecords(records: GazetteerSourceRecord[], version: string): Gazetteer {
  const index = buildIndex(records);
  return {
    async ensureReady() {
      // Index is built synchronously above; nothing to await.
    },
    resolvePlace(name: string): GazetteerHit | null {
      return resolveAgainst(index, name);
    },
    getVersion(): string {
      return version;
    },
  };
}

const EMPTY_GAZETTEER: Gazetteer = {
  async ensureReady() {},
  resolvePlace: () => null,
  getVersion: () => 'unavailable',
};

// ── Fetch discipline (mirrors services/celestrak-visual.ts / services/swpc.ts) ─

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRawGeoJsonText(): Promise<string> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      logger.info(`Gazetteer fetch attempt ${attempt}/${RETRY_COUNT}`);
      const response = await axios.get<string>(GAZETTEER_SOURCE_URL, {
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
      logger.warn(`Gazetteer fetch attempt ${attempt} failed (HTTP ${status ?? 'timeout/network'})`);
      if (attempt < RETRY_COUNT) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : 'unknown error';
  throw new Error(`Gazetteer fetch failed after ${RETRY_COUNT} attempts: ${detail}`);
}

async function fetchAndParseRecords(): Promise<GazetteerSourceRecord[]> {
  const text = await fetchRawGeoJsonText();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Gazetteer response was not valid JSON: ${(err as Error).message}`);
  }
  return parseGazetteerGeoJson(raw);
}

/** Fresh cache → use it. Otherwise fetch; on fetch failure fall back to
 *  whatever is on disk even if stale (mirrors routes/tle-visual.ts's
 *  resolveVisualPayload "stale-ok" fallback); only null if there is truly
 *  nothing usable anywhere. Never throws. */
async function loadFromNetworkOrCache(): Promise<GazetteerCache | null> {
  if (isGazetteerCacheFresh()) {
    const cached = readGazetteerCache();
    if (cached && cached.records.length > 0) {
      logger.info(`Gazetteer: using fresh cache (${cached.records.length} records, version=${cached.version})`);
      return cached;
    }
  }

  try {
    const records = await fetchAndParseRecords();
    if (records.length === 0) throw new Error('parsed zero gazetteer records');
    const written = writeGazetteerCache(records);
    logger.info(`Gazetteer: fetched + cached ${written.records.length} records`);
    return written;
  } catch (err) {
    logger.warn(`Gazetteer fetch failed; falling back to cache if present (stale-ok): ${(err as Error).message}`);
    const stale = readGazetteerCache();
    if (stale && stale.records.length > 0) {
      logger.warn(`Gazetteer: using STALE cache (${stale.records.length} records, version=${stale.version})`);
      return stale;
    }
    logger.warn('Gazetteer: no usable cache either — place-name grounding disabled for this process.');
    return null;
  }
}

// ── Default (production) singleton ─────────────────────────────────────────
//
// Lazily loaded — nothing here runs at module import time, so importing this
// module (directly or via analytic-compiler.ts) never touches the network,
// which is what keeps `npm run test` network-free. The first call to
// ensureReady() from a question that actually mentions a place pays the
// fetch-or-cache-read cost once per process; every call after that resolves
// immediately against the in-memory index.

let loaded: Gazetteer | null = null;
let loadingPromise: Promise<Gazetteer> | null = null;

async function buildSingleton(): Promise<Gazetteer> {
  try {
    const cache = await loadFromNetworkOrCache();
    if (!cache) return EMPTY_GAZETTEER;
    return createGazetteerFromRecords(cache.records, cache.version);
  } catch (err) {
    // Belt-and-suspenders: loadFromNetworkOrCache already fail-softs internally,
    // but resolvePlace must NEVER be reachable from a thrown/rejected load.
    logger.warn('Gazetteer singleton build failed unexpectedly (fail-soft, resolvePlace will return null):', err);
    return EMPTY_GAZETTEER;
  }
}

const defaultGazetteer: Gazetteer = {
  async ensureReady() {
    if (loaded) return;
    if (!loadingPromise) loadingPromise = buildSingleton();
    loaded = await loadingPromise;
  },
  resolvePlace(name: string): GazetteerHit | null {
    return loaded ? loaded.resolvePlace(name) : null;
  },
  getVersion(): string {
    return loaded ? loaded.getVersion() : 'unloaded';
  },
};

/** The production, network/cache-backed gazetteer singleton for this process. */
export function getDefaultGazetteer(): Gazetteer {
  return defaultGazetteer;
}
