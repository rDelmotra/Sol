import type { EnrichedTLEObject } from '@orbitwatch/contracts';

// ============================================================
// CelesTrak overlay
//
// CelesTrak has no group that holds the full catalog (GROUP=active is about 16.7k
// active satellites), so its answer can never replace the cached catalog. It is
// laid over it:
//   - an id already cached: the CelesTrak record replaces it only if its epoch is
//     strictly NEWER (equal or older never replaces)
//   - an id not cached: added at the end
//   - every other cached object: kept as it is
// So the result never has fewer objects than the cache. With no cache the result is
// just the CelesTrak records.
//
// Ids are plain numbers (100000 and up work the same as 5 digits).
// ============================================================

export interface OverlayResult {
  catalog: EnrichedTLEObject[];
  /** Cached objects replaced by a newer CelesTrak record. */
  replaced: number;
  /** CelesTrak objects that were not cached. */
  added: number;
}

/** Epoch as ms. An unreadable epoch is -Infinity: anything readable is newer than it. */
function epochMs(epoch: string | undefined): number {
  const t = epoch ? Date.parse(epoch) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Lay `fresh` (built from CelesTrak) over `cached`. Neither input is changed. */
export function overlayCatalog(cached: EnrichedTLEObject[] | null, fresh: EnrichedTLEObject[]): OverlayResult {
  // One record per id inside the fresh set too: the newest epoch wins.
  const freshById = new Map<number, EnrichedTLEObject>();
  for (const obj of fresh) {
    const seen = freshById.get(obj.noradId);
    if (!seen || epochMs(obj.epoch) > epochMs(seen.epoch)) freshById.set(obj.noradId, obj);
  }

  if (!cached || cached.length === 0) {
    return { catalog: Array.from(freshById.values()), replaced: 0, added: freshById.size };
  }

  let replaced = 0;
  const used = new Set<number>();
  const catalog = cached.map((old) => {
    const candidate = freshById.get(old.noradId);
    if (!candidate) return old;
    used.add(old.noradId);
    if (epochMs(candidate.epoch) > epochMs(old.epoch)) {
      replaced++;
      return candidate;
    }
    return old;
  });

  let added = 0;
  for (const [id, obj] of freshById) {
    if (used.has(id)) continue;
    catalog.push(obj);
    added++;
  }

  return { catalog, replaced, added };
}
