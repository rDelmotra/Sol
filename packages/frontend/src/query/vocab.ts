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
import {
  extendAliasTable,
  displayNameKeys,
  normalizeAliasKey,
  type AliasEntry,
} from './aliases';

export interface VocabIndexes {
  vehicleTags: Map<string, Set<string>>; // lvFamily value → launch tags
  siteTags: Map<string, Set<string>>;    // siteName value → launch tags
  yearTags: Map<string, Set<string>>;    // 'YYYY' → launch tags
  // Owner name-key → owner org codes, FAMILY-expanded (an org + its parent-tree
  // descendants) and accumulated across every org that produces the key. This
  // is what makes "spacex" (SPX+SPXS) and "nasa" (NASA + all centers) resolve
  // to the whole fleet instead of one arbitrary code.
  ownerCodes: Map<string, Set<string>>;
  // Agency name-key → launch tags (the launches that org conducted).
  agencyTags: Map<string, Set<string>>;
}

let indexes: VocabIndexes | null = null;
// Raw vocab retained for consumers that need per-tag/per-code values rather than
// inverted indexes (the analytic live source's dotted launch.*/owner.* fields).
let rawVocab: QueryVocab | null = null;

export function getVocabIndexes(): VocabIndexes | null {
  return indexes;
}

/** The raw installed vocab (launch tag → [family, site, agencies]; org code → {n,a,p}). */
export function getRawQueryVocab(): QueryVocab | null {
  return rawVocab;
}

/** True once the vocab has been fetched + installed (gates the year parse rule). */
export function hasQueryVocab(): boolean {
  return indexes !== null;
}

function addTo(m: Map<string, Set<string>>, key: string, value: string): void {
  let s = m.get(key);
  if (!s) m.set(key, (s = new Set<string>()));
  s.add(value);
}

/**
 * Pure — build the launch-side inverted indexes (vehicle/site/year) + the
 * agency-code → tags map used by installQueryVocab to resolve agency names.
 */
export function buildVocabIndexes(
  vocab: QueryVocab,
): { vehicleTags: Map<string, Set<string>>; siteTags: Map<string, Set<string>>;
     yearTags: Map<string, Set<string>>; agencyCodeToTags: Map<string, Set<string>> } {
  const vehicleTags = new Map<string, Set<string>>();
  const siteTags = new Map<string, Set<string>>();
  const yearTags = new Map<string, Set<string>>();
  const agencyCodeToTags = new Map<string, Set<string>>();
  for (const [tag, tuple] of Object.entries(vocab.launches)) {
    const [lvFamily, siteName, agencyCodes] = tuple;
    if (lvFamily && lvFamily !== 'UNK') addTo(vehicleTags, lvFamily, tag);
    if (siteName) addTo(siteTags, siteName, tag);
    const year = tag.slice(0, 4); // "2019-074" | "1957 ALP" → "2019" | "1957"
    if (/^\d{4}$/.test(year)) addTo(yearTags, year, tag);
    for (const code of agencyCodes ?? []) addTo(agencyCodeToTags, code, tag);
  }
  return { vehicleTags, siteTags, yearTags, agencyCodeToTags };
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
 * Normalized alias keys for an org: its full display name (UNCONDITIONAL — so a
 * pivot's injected exact name always resolves), plus derived short-forms/variants
 * that clear the generic-word guardrail.
 */
function orgNameKeys(o: { n: string; a?: string[] }): string[] {
  const keys = new Set<string>();
  const full = normalizeAliasKey(o.n);
  if (full) keys.add(full);
  const derivedRaw = [
    ...displayNameKeys(o.n),
    ...(o.a ?? []).flatMap((a) => [a, ...displayNameKeys(a)]),
  ];
  for (const raw of derivedRaw) {
    const k = normalizeAliasKey(raw);
    if (k && derivedOrgKeyAllowed(k)) keys.add(k);
  }
  return [...keys];
}

function titleCase(key: string): string {
  return key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Prefer an org name that IS this key (exact base match) as the chip label. */
function preferLabel(labels: Map<string, string>, key: string, name: string): void {
  if (normalizeAliasKey(name) === key) labels.set(key, name);
  else if (!labels.has(key)) labels.set(key, titleCase(key));
}

/**
 * Build the indexes + register the alias entries. Registration ORDER is
 * load-bearing (first-writer-wins within the dynamic set): vehicles → sites →
 * pre-1963 tags → owners → agencies, so agency never shadows an owner word and
 * neither shadows a vehicle/site word. Static entries (registered at module
 * load) beat everything here.
 *
 * Operators resolve to their whole org FAMILY: a name-key maps to every in-orbit
 * owner in the parent-tree subtree of any org producing that key. This is what
 * makes "spacex" (SPX + SPXS via a shared name token) and "nasa" (NASA + its
 * centers via the parent tree) return the full fleet.
 */
export function installQueryVocab(vocab: QueryVocab): void {
  rawVocab = vocab;
  const built = buildVocabIndexes(vocab);
  const ownerSet = new Set(vocab.owners);

  // Parent tree over emitted orgs → each org's descendant codes.
  const childrenOf = new Map<string, string[]>();
  for (const [code, o] of Object.entries(vocab.orgs)) {
    if (o.p) (childrenOf.get(o.p) ?? childrenOf.set(o.p, []).get(o.p)!).push(code);
  }
  const familyOwners = (code: string): string[] => {
    const out: string[] = [];
    const stack = [code];
    const seen = new Set<string>();
    let guard = 0;
    while (stack.length && guard++ < 10000) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      if (ownerSet.has(c)) out.push(c);
      for (const child of childrenOf.get(c) ?? []) stack.push(child);
    }
    return out;
  };

  // Owner name-key → family owner codes; agency name-key → launch tags.
  const ownerCodes = new Map<string, Set<string>>();
  const agencyTags = new Map<string, Set<string>>();
  const ownerLabels = new Map<string, string>();
  const agencyLabels = new Map<string, string>();
  for (const [code, o] of Object.entries(vocab.orgs)) {
    const keys = orgNameKeys(o);
    const owners = familyOwners(code);
    const agencyTagSet = built.agencyCodeToTags.get(code);
    for (const key of keys) {
      for (const c of owners) addTo(ownerCodes, key, c);
      if (owners.length > 0) preferLabel(ownerLabels, key, o.n);
      if (agencyTagSet) {
        for (const t of agencyTagSet) addTo(agencyTags, key, t);
        preferLabel(agencyLabels, key, o.n);
      }
    }
  }

  indexes = {
    vehicleTags: built.vehicleTags,
    siteTags: built.siteTags,
    yearTags: built.yearTags,
    ownerCodes,
    agencyTags,
  };

  const entries: [string, AliasEntry][] = [];
  // 1. Vehicles (family names + spaced variants; 'UNK' already excluded).
  for (const family of built.vehicleTags.keys()) {
    for (const k of familyKeys(family)) {
      entries.push([k, { group: 'vehicle', value: family, label: family }]);
    }
  }
  // 2. Sites (canonical names + a tiny hand synonym map for famous spellings).
  for (const site of built.siteTags.keys()) {
    entries.push([site, { group: 'site', value: site, label: site }]);
  }
  for (const [typed, canonical] of Object.entries(SITE_HAND_SYNONYMS)) {
    if (built.siteTags.has(canonical)) {
      entries.push([typed, { group: 'site', value: canonical, label: canonical }]);
    }
  }
  // 3. Pre-1963 launch tags (modern ones use the parser regex rule).
  for (const tag of Object.keys(vocab.launches)) {
    if (!MODERN_TAG_RE.test(tag)) {
      entries.push([tag, { group: 'launch', value: tag, label: `Launch ${tag}` }]);
    }
  }
  // 4. Owners (value = name-key; the executor expands it via ownerCodes).
  for (const key of ownerCodes.keys()) {
    entries.push([key, { group: 'owner', value: key, label: ownerLabels.get(key) ?? titleCase(key) }]);
  }
  // 5. Agencies LAST — owner wins any shared name (owns what it launches);
  //    unique provider names (Arianespace, Rocket Lab) survive as agency.
  for (const key of agencyTags.keys()) {
    entries.push([key, { group: 'agency', value: key, label: agencyLabels.get(key) ?? titleCase(key) }]);
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
  rawVocab = null;
  fetchPromise = null;
}
