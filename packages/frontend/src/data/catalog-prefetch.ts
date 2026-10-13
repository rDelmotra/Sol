import { fetchTleCatalog, type TleCatalogResult } from './tle-client';

// ============================================================
// Early catalog start.
//
// The Engine (and three.js) load lazily, so the catalog request used to begin only
// after those chunks had downloaded and the Engine had been built. main.tsx calls
// startCatalogPrefetch() instead, as soon as the entry script runs; bootstrapCatalog()
// then picks up the request that is already in flight. Same function, same IndexedDB
// revisit cache, same single request — just started earlier.
// ============================================================

interface Prefetch {
  apiUrl: string;
  promise: Promise<TleCatalogResult>;
}

let pending: Prefetch | null = null;

/** Start the catalog request now. Does nothing if one is already waiting to be picked up. */
export function startCatalogPrefetch(
  apiUrl: string,
  fetchCatalog: (apiUrl: string) => Promise<TleCatalogResult> = fetchTleCatalog,
): void {
  if (pending) return;
  const promise = fetchCatalog(apiUrl);
  // The consumer reports a failure. This only stops an early failure from also
  // surfacing as an "unhandled rejection" before the Engine has picked it up.
  promise.catch(() => {});
  pending = { apiUrl, promise };
}

/**
 * Hand over the in-flight early request, once. Returns null when none was started,
 * it was already taken, or it was started for a different API base — the caller then
 * makes its own request (so a retry never reuses a failed early one).
 */
export function takeCatalogPrefetch(apiUrl: string): Promise<TleCatalogResult> | null {
  if (!pending || pending.apiUrl !== apiUrl) return null;
  const { promise } = pending;
  pending = null;
  return promise;
}
