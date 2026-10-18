// ============================================================
// query/vocab.ts — the installed launch/org vocabulary.
//
// Fetched lazily from /api/query/vocab and kept as the raw artifact. The only
// reader is the analytic live source (Engine.ts passes getRawQueryVocab() as
// its `getVocab`), which resolves the dotted launch.* / owner.* fields from it.
//
// Module singleton. Pure install path (installQueryVocab takes parsed JSON) so
// it's node-testable without fetch.
//
// NOTE: nothing calls ensureQueryVocab() since the cockpit replaced SearchBar
// (the old caller), so the vocab is never installed in the live app. See
// state/OPEN.md.
// ============================================================

import { fetchQueryVocab, type QueryVocab } from '../data/query-vocab-client';

// Raw vocab retained for consumers that need per-tag/per-code values (the
// analytic live source's dotted launch.*/owner.* fields).
let rawVocab: QueryVocab | null = null;

/** The raw installed vocab (launch tag → [family, site, agencies]; org code → {n,a,p}). */
export function getRawQueryVocab(): QueryVocab | null {
  return rawVocab;
}

/** Install a parsed vocab artifact (pure; no fetch). */
export function installQueryVocab(vocab: QueryVocab): void {
  rawVocab = vocab;
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

/** Test-only: drop the installed vocab + in-flight promise. */
export function resetQueryVocabForTests(): void {
  rawVocab = null;
  fetchPromise = null;
}
