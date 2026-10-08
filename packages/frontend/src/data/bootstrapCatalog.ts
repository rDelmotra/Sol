import type { TLEInput, FacetCounts } from './types';
import type { EnrichedTLEObject, ObjectCategory, OrbitalRegime } from '@orbitwatch/contracts';
import { fetchTleCatalog } from './tle-client';

export interface BootstrapCatalogInfo {
  objectCount: number;
  categoryCounts: Record<ObjectCategory, number>;
  regimeCounts: Record<OrbitalRegime, number>;
  facetCounts?: FacetCounts;
}

export interface BootstrapCatalogResult {
  catalogData: EnrichedTLEObject[];
  tles: TLEInput[];
  /** Exact argument the caller passes to `store.setCatalogInfo`. */
  catalogInfo: BootstrapCatalogInfo;
}

/**
 * One-time catalog bootstrap — pure data: fetch the TLE catalog. Returns the
 * catalog + parsed TLEs + catalog info for the Engine to seed the store and
 * wire into the render layer (renderer priming + GPU picker stay in the
 * Engine/render side, so `data/` never imports `engine/` or the store).
 *
 * This is deliberately a thin function, NOT a manager. Per-tick propagation,
 * subscriptions, and command/trigger registration stay in the Engine.
 */
export async function bootstrapCatalog(apiUrl: string): Promise<BootstrapCatalogResult> {
  const { catalogData, tles, categoryCounts, regimeCounts, facetCounts } = await fetchTleCatalog(apiUrl);

  return {
    catalogData,
    tles,
    catalogInfo: {
      objectCount: catalogData.length,
      categoryCounts,
      regimeCounts,
      facetCounts,
    },
  };
}
