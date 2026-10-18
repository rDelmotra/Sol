import type { LoadGate } from '../../data/load-gate';

/**
 * Decides WHEN the Earth textures may start downloading.
 *
 * On a first visit they wait for the catalog request to settle (or a maximum
 * wait), so the catalog gets the whole link. If every texture is already in the
 * service worker's cache there is nothing to download — the files come off disk —
 * so they start at once instead of waiting behind a catalog download.
 *
 * Never rejects. Any problem with the cache lookup counts as "not cached", which
 * falls back to waiting on the gate.
 */
export async function textureStartGate(
  urls: readonly string[],
  gate: LoadGate,
  isCached: (urls: readonly string[]) => Promise<boolean> = allInCacheStorage,
  maxWaitMs?: number,
): Promise<void> {
  if (gate.settled) return;
  let cached = false;
  try {
    cached = await isCached(urls);
  } catch {
    cached = false;
  }
  if (cached) return;
  await gate.whenOpen(maxWaitMs);
}

/** True when the browser's Cache Storage (the service worker's asset cache) holds every url. */
export async function allInCacheStorage(urls: readonly string[]): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  const hits = await Promise.all(urls.map((u) => caches.match(u)));
  return hits.every((h) => h !== undefined);
}
