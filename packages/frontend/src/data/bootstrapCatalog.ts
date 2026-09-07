import type { EnrichedTLEObject, TLEInput } from './types';
import { fetchTleCatalog } from './tle-client';
import { useStore } from '../store/useStore';

export interface BootstrapCatalogResult {
  catalogData: EnrichedTLEObject[];
  tles: TLEInput[];
}

/**
 * One-time catalog bootstrap — pure data: fetch the TLE catalog and seed the
 * store with it. Returns the catalog + parsed TLEs for the Engine to wire into
 * the render layer (renderer priming + GPU picker stay in the Engine/render
 * side, so `data/` never imports `engine/` — the dependency rule).
 *
 * This is deliberately a thin function, NOT a manager. Per-tick propagation,
 * subscriptions, and command/trigger registration stay in the Engine.
 */
export async function bootstrapCatalog(apiUrl: string): Promise<BootstrapCatalogResult> {
  const { catalogData, tles, categoryCounts, regimeCounts, facetCounts } = await fetchTleCatalog(apiUrl);

  const store = useStore.getState();
  store.setCatalogInfo({
    objectCount: catalogData.length,
    categoryCounts,
    regimeCounts,
    facetCounts,
  });
  store.setCatalogData(catalogData);

  return { catalogData, tles };
}
