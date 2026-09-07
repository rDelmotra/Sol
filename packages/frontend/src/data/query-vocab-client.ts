// ============================================================
// query-vocab-client.ts — lazy fetch of the search-vocabulary artifact
//
// GET /api/query/vocab → the compact launch/org vocabulary that the query tier
// installs into the alias table at runtime (see query/vocab.ts). Non-blocking:
// the app renders and searches without it (vehicle/site/owner tokens simply
// ride to Fuse until it lands). null on any failure — the caller retries.
// ============================================================

// Optional-chained so the module is importable under node:test (tsx), where
// Vite's import.meta.env injection is absent.
const API_BASE = import.meta.env?.VITE_API_URL ?? '';

export interface QueryVocab {
  /** tag → [lvFamily, siteName, agencyCodes] (nulls/[] preserved). */
  launches: Record<string, [string | null, string | null, string[]]>;
  /** org code → { n: name, a?: alias variants, p?: parent code } (owners + agencies + ancestors). */
  orgs: Record<string, { n: string; a?: string[]; p?: string }>;
  /** Codes that own ≥1 in-orbit object — distinguishes operator vs agency-only names. */
  owners: string[];
}

export async function fetchQueryVocab(): Promise<QueryVocab | null> {
  try {
    const res = await fetch(`${API_BASE}/api/query/vocab`);
    if (!res.ok) return null;
    return (await res.json()) as QueryVocab;
  } catch {
    return null;
  }
}
