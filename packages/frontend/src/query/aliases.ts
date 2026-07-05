// ============================================================
// Alias dictionaries — the local parser's vocabulary.
//
// One flat lookup table from lowercase, space-normalized n-gram keys to a
// canonical (group, value, label). Built once at module load, first-writer-
// wins in a fixed PRECEDENCE ORDER so conflicts are deterministic:
//
//   regime → type → status → sector → country → program → purpose
//
// Consequences (intentional):
//   • 'gps'  → program gps, NOT purpose navigation (program registered first)
//   • 'usa'  → country US; the DoD 'usa'/'ops' program slugs are blocklisted
//     and unreachable by text (reachable via a future program UI)
//   • 'unknown' → status unknown (status precedes country's TBD name)
// ============================================================

import { COUNTRY_DISPLAY, displayCountry } from '../data/country-codes';
import {
  SECTOR_LABELS,
  PURPOSE_LABELS,
  ORBITAL_STATUS_LABELS,
  PROGRAM_LABELS,
  type Purpose,
} from '../data/metadata-types';
import type { FacetGroup } from './types';

export interface AliasEntry {
  group: FacetGroup;
  value: string;
  label: string;
}

/** Words consumed silently: never matched, never passed to the residual. */
export const STOPWORDS = new Set([
  'show', 'me', 'all', 'in', 'the', 'of', 'a', 'an', 'and', 'everything',
  'every', 'that', 'operates', 'operating', 'orbit', 'orbits', 'with', 'from',
  'by', 'for', 'what', 'which', 'list', 'find',
]);

// Labels duplicated from FilterPanel.tsx (a .tsx module — the pure query tier
// must not import it). Keep in sync if the panel wording changes.
const REGIME_ALIAS_LABELS: Record<string, string> = {
  LEO: 'LEO', MEO: 'MEO', GEO: 'GEO', HEO: 'HEO', OTHER: 'Other',
};
const TYPE_ALIAS_LABELS: Record<string, string> = {
  satellite: 'Payload', rocket_body: 'Rocket Body', debris: 'Debris',
  unknown: 'Unknown', deep_space: 'Deep Space',
};

/** Program slugs that must never be reachable by text. */
const PROGRAM_BLOCKLIST = new Set(['usa', 'ops']);
/** Org "country" codes whose display names collide with programs. */
const COUNTRY_NAME_BLOCKLIST = new Set(['ITSO', 'EUTE', 'SES', 'GLOB', 'TBD']);

function put(
  table: Map<string, AliasEntry>,
  key: string,
  entry: AliasEntry,
): void {
  const norm = key.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!norm) return;
  if (!table.has(norm)) table.set(norm, entry); // first writer wins
}

/** "GPS (Navstar)" → ['gps']; "SES / Astra" → ['ses', 'astra']. */
function displayNameKeys(display: string): string[] {
  return display
    .replace(/\([^)]*\)/g, ' ')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildTable(): Map<string, AliasEntry> {
  const t = new Map<string, AliasEntry>();

  // ── 1. Regimes ──────────────────────────────────────────────────────────────
  const regime = (value: string, ...keys: string[]) => {
    for (const k of keys) put(t, k, { group: 'regime', value, label: REGIME_ALIAS_LABELS[value] });
  };
  regime('LEO', 'leo', 'low earth orbit');
  regime('MEO', 'meo', 'medium earth orbit');
  regime('GEO', 'geo', 'geostationary', 'geosynchronous', 'geostationary orbit');
  regime('HEO', 'heo', 'highly elliptical', 'highly elliptical orbit');

  // ── 2. Types ────────────────────────────────────────────────────────────────
  const type = (value: string, ...keys: string[]) => {
    for (const k of keys) put(t, k, { group: 'type', value, label: TYPE_ALIAS_LABELS[value] });
  };
  type('satellite', 'satellite', 'satellites', 'sat', 'sats', 'payload', 'payloads');
  type('rocket_body', 'rocket body', 'rocket bodies', 'rocket', 'rockets', 'r/b', 'rb');
  type('debris', 'debris', 'junk', 'space junk');

  // ── 3. Statuses ─────────────────────────────────────────────────────────────
  for (const [value, label] of Object.entries(ORBITAL_STATUS_LABELS)) {
    put(t, label, { group: 'status', value, label });
  }
  put(t, 'active', { group: 'status', value: 'in_orbit', label: ORBITAL_STATUS_LABELS.in_orbit });
  put(t, 'reentered', { group: 'status', value: 'decayed', label: ORBITAL_STATUS_LABELS.decayed });
  put(t, 're-entered', { group: 'status', value: 'decayed', label: ORBITAL_STATUS_LABELS.decayed });

  // ── 4. Sectors ──────────────────────────────────────────────────────────────
  for (const [value, label] of Object.entries(SECTOR_LABELS)) {
    if (value === 'unspecified') continue; // nobody types it; FilterPanel-only
    put(t, label, { group: 'sector', value, label });
  }
  put(t, 'mil', { group: 'sector', value: 'military', label: SECTOR_LABELS.military });
  put(t, 'govt', { group: 'sector', value: 'government', label: SECTOR_LABELS.government });
  put(t, 'civilian', { group: 'sector', value: 'civil', label: SECTOR_LABELS.civil });

  // ── 5. Countries — names from COUNTRY_DISPLAY + hand demonyms ──────────────
  const country = (code: string, ...keys: string[]) => {
    for (const k of keys) put(t, k, { group: 'country', value: code, label: displayCountry(code) });
  };
  for (const [code, disp] of Object.entries(COUNTRY_DISPLAY)) {
    if (COUNTRY_NAME_BLOCKLIST.has(code)) continue;
    // Split composites ('Russia / CIS') and strip parentheticals.
    for (const key of displayNameKeys(disp.name)) country(code, key);
  }
  country('PRC', 'chinese', 'china', 'prc');
  country('CIS', 'russian', 'russia', 'soviet', 'cis');
  country('US', 'american', 'us', 'usa');
  country('IND', 'indian', 'india');
  country('JPN', 'japanese', 'japan');
  country('FR', 'french', 'france');
  country('GER', 'german', 'germany');
  country('UK', 'british', 'uk');
  country('CA', 'canadian', 'canada');
  country('ISRA', 'israeli', 'israel');
  country('SKOR', 'korean', 'south korean');
  country('SPN', 'spanish', 'spain');
  country('AUS', 'australian', 'australia');
  country('TURK', 'turkish', 'turkey');
  country('BRAZ', 'brazilian', 'brazil');
  country('NETH', 'dutch', 'netherlands');
  country('ESA', 'european', 'esa', 'europe');

  // ── 6. Programs — slugs + display names + hand extras ──────────────────────
  const program = (slug: string, ...keys: string[]) => {
    const label = PROGRAM_LABELS[slug] ?? slug;
    for (const k of keys) put(t, k, { group: 'program', value: slug, label });
  };
  for (const [slug, display] of Object.entries(PROGRAM_LABELS)) {
    if (PROGRAM_BLOCKLIST.has(slug)) continue;
    program(slug, slug, ...displayNameKeys(display));
  }
  program('gps', 'navstar');
  program('navic', 'irnss');
  program('chinasat', 'zhongxing');
  program('lemur', 'spire');
  program('geesat', 'geely');
  program('qianfan', 'g60');

  // ── 7. Purposes — labels + synonyms (lowest precedence) ────────────────────
  const purpose = (value: Purpose, ...keys: string[]) => {
    for (const k of keys) put(t, k, { group: 'purpose', value, label: PURPOSE_LABELS[value] });
  };
  for (const [value, label] of Object.entries(PURPOSE_LABELS)) {
    if (value === 'other') continue; // 'Other / Unspecified' is not a query word
    purpose(value as Purpose, label);
  }
  purpose('communications', 'communication', 'comms', 'comsat');
  purpose('earth_observation', 'imaging', 'imagery', 'eo');
  purpose('navigation', 'nav', 'positioning');
  purpose('technology_dev', 'technology', 'tech demo');
  purpose('space_science', 'science');
  purpose('space_observation', 'astronomy');
  purpose('surveillance', 'spy', 'recon', 'reconnaissance', 'sigint', 'early warning');
  purpose('meteorological', 'weather', 'meteorology');

  return t;
}

export const ALIAS_TABLE: Map<string, AliasEntry> = buildTable();

/** Longest key in words — the parser's n-gram window. */
export const MAX_NGRAM: number = (() => {
  let max = 1;
  for (const key of ALIAS_TABLE.keys()) {
    const words = key.split(' ').length;
    if (words > max) max = words;
  }
  return max;
})();
