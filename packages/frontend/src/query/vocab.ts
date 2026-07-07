// ============================================================
// query/vocab.ts — runtime launch-graph vocabulary for the query tier.
//
// Fetched lazily from /api/query/vocab and installed into the alias table so
// vehicle / site / launch-year / operator words become matchable. Also builds
// the inverted indexes (family/site/year → launch tags) the executor unions to
// compile those facets down to a launch-tag allow-set.
//
// Module singleton, mirroring ALIAS_TABLE. Pure install path (installQueryVocab
// takes parsed JSON) so it's node-testable without fetch.
// ============================================================

import { fetchQueryVocab, type QueryVocab } from '../data/query-vocab-client';
import { extendAliasTable, displayNameKeys, type AliasEntry } from './aliases';

export interface VocabIndexes {
  vehicleTags: Map<string, Set<string>>; // lvFamily value → launch tags
  siteTags: Map<string, Set<string>>;    // siteName value → launch tags
  yearTags: Map<string, Set<string>>;    // 'YYYY' → launch tags
}

let indexes: VocabIndexes | null = null;

export function getVocabIndexes(): VocabIndexes | null {
  return indexes;
}

/** True once the vocab has been fetched + installed (gates the year parse rule). */
export function hasQueryVocab(): boolean {
  return indexes !== null;
}

/** Pure — one pass over vocab.launches building the three inverted indexes. */
export function buildVocabIndexes(vocab: QueryVocab): VocabIndexes {
  const vehicleTags = new Map<string, Set<string>>();
  const siteTags = new Map<string, Set<string>>();
  const yearTags = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, key: string, tag: string) => {
    let s = m.get(key);
    if (!s) m.set(key, (s = new Set<string>()));
    s.add(tag);
  };
  for (const [tag, [lvFamily, siteName]] of Object.entries(vocab.launches)) {
    if (lvFamily && lvFamily !== 'UNK') add(vehicleTags, lvFamily, tag);
    if (siteName) add(siteTags, siteName, tag);
    const year = tag.slice(0, 4); // "2019-074" | "1957 ALP" → "2019" | "1957"
    if (/^\d{4}$/.test(year)) add(yearTags, year, tag);
  }
  return { vehicleTags, siteTags, yearTags };
}

/**
 * "Falcon9" → ['falcon9', 'falcon 9']; "BlackArrow" → ['blackarrow',
 * 'black arrow']; "R-7" → ['r-7'] (hyphen untouched). Splits camelCase and
 * letter/digit boundaries so both compact and spaced spellings match.
 */
function familyKeys(family: string): string[] {
  const spaced = family
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return [...new Set([family, spaced])];
}

// Modern tags use the parser's regex rule; only the 151 pre-1963 "1957 ALP"
// tags need explicit alias entries so the "Same launch" pivot parses them.
const MODERN_TAG_RE = /^(19|20)\d{2}-\d{3}$/;

// A few famous sites whose GCAT spelling differs from what people type.
const SITE_HAND_SYNONYMS: Record<string, string> = {
  'cape canaveral': 'Canaveral',
  baikonur: 'Baykonur',
};

// Generic words that must never become an operator alias on their own (they'd
// hijack unrelated queries). Applies to DERIVED keys only — a full org display
// name equal to one of these is still registered so its pivot resolves.
const ORG_ALIAS_STOPLIST = new Set([
  'star', 'space', 'global', 'earth', 'world', 'international', 'national',
]);

/** Derived (short-form / variant) org keys: reject generic single words. */
function derivedOrgKeyAllowed(normKey: string): boolean {
  if (normKey.includes(' ')) return true; // multi-word is specific enough
  return normKey.length > 2 && !ORG_ALIAS_STOPLIST.has(normKey);
}

/**
 * Build the indexes + register the alias entries. Registration ORDER is
 * load-bearing (first-writer-wins within the dynamic set): vehicles → sites →
 * pre-1963 tags → orgs LAST, so an org alias can never shadow a vehicle/site
 * word. Static entries were registered at module load and beat everything here.
 */
export function installQueryVocab(vocab: QueryVocab): void {
  indexes = buildVocabIndexes(vocab);
  const entries: [string, AliasEntry][] = [];

  // 1. Vehicles (family names + spaced variants; 'UNK' already excluded).
  for (const family of indexes.vehicleTags.keys()) {
    for (const k of familyKeys(family)) {
      entries.push([k, { group: 'vehicle', value: family, label: family }]);
    }
  }
  // 2. Sites (canonical names + a tiny hand synonym map for famous spellings).
  for (const site of indexes.siteTags.keys()) {
    entries.push([site, { group: 'site', value: site, label: site }]);
  }
  for (const [typed, canonical] of Object.entries(SITE_HAND_SYNONYMS)) {
    if (indexes.siteTags.has(canonical)) {
      entries.push([typed, { group: 'site', value: canonical, label: canonical }]);
    }
  }
  // 3. Pre-1963 launch tags (modern ones use the parser regex rule).
  for (const tag of Object.keys(vocab.launches)) {
    if (!MODERN_TAG_RE.test(tag)) {
      entries.push([tag, { group: 'launch', value: tag, label: `Launch ${tag}` }]);
    }
  }
  // 4. Orgs LAST. Full display name registered unconditionally (guarantees the
  //    InfoCard pivot's injected exact name longest-matches to ITS code); the
  //    derived short forms + variants pass the generic-word guardrail.
  for (const [code, o] of Object.entries(vocab.orgs)) {
    const entry: AliasEntry = { group: 'owner', value: code, label: o.n };
    entries.push([o.n, entry]);
    const derived = [
      ...displayNameKeys(o.n),
      ...(o.a ?? []).flatMap((a) => [a, ...displayNameKeys(a)]),
    ];
    for (const k of derived) {
      if (derivedOrgKeyAllowed(k.trim().toLowerCase())) entries.push([k, entry]);
    }
  }

  extendAliasTable(entries);
}

let fetchPromise: Promise<void> | null = null;

/**
 * Idempotent lazy fetch + install. On failure the promise is cleared so a later
 * call retries. Safe to call from multiple mount effects — only one fetch runs.
 */
export function ensureQueryVocab(): Promise<void> {
  fetchPromise ??= fetchQueryVocab().then((v) => {
    if (v) installQueryVocab(v);
    else fetchPromise = null; // allow retry
  });
  return fetchPromise;
}

/** Test-only: drop the installed indexes + in-flight promise. */
export function resetQueryVocabForTests(): void {
  indexes = null;
  fetchPromise = null;
}
