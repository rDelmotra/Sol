import type { TLEInput, EnrichedTLEObject, ObjectCategory, OrbitalRegime, FacetCounts } from './types';
import { emptyFacetCounts } from './types';
import type { Sector, Purpose, OrbitalStatus } from './metadata-types';
import { readCatalogCache, writeCatalogCache } from './catalog-cache';
import {
  fetchVisualList,
  type VisualListResolvedResult,
} from './visualList';

// ── TLE Catalog Fetch ─────────────────────────────────────────────────────

export interface TleCatalogResult {
  catalogData: EnrichedTLEObject[];
  tles: TLEInput[];
  categoryCounts: Record<ObjectCategory, number>;
  regimeCounts: Record<OrbitalRegime, number>;
  /** Rich-metadata facet totals (type/status/sector/purpose/country) — Phase B. */
  facetCounts: FacetCounts;
}

// Warm-load staleness ceiling. Within this window we render from the IndexedDB
// cache instantly (and refresh in the background); beyond it we block on a fresh
// fetch. This is a PURE client-side decision — it does not consult the backend
// version, so the cache works even offline / independent of cron updates.
const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Derive the renderer-facing result (TLE inputs + counts) from raw catalog. */
export function buildCatalogResult(catalogData: EnrichedTLEObject[]): TleCatalogResult {
  // Defensive: a catalog cached before the facet fields existed (stale backend
  // cache / old IndexedDB copy) would lack sectors/purpose/status, and the render
  // path reads them unconditionally. Coalesce in place so nothing reads undefined.
  for (const obj of catalogData) {
    const o = obj as Partial<Pick<EnrichedTLEObject, 'sectors' | 'purpose' | 'status'>> & EnrichedTLEObject;
    if (!o.sectors) o.sectors = [] as Sector[];
    if (!o.purpose) o.purpose = 'other' as Purpose;
    if (!o.status) o.status = 'unknown' as OrbitalStatus;
  }

  const tles: TLEInput[] = catalogData.map((d) => ({
    noradId: d.noradId,
    omm: d.omm,
  }));

  const categoryCounts: Record<ObjectCategory, number> = {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  };
  const regimeCounts: Record<OrbitalRegime, number> = {
    LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0,
  };
  // Phase B facet totals — tallied in the SAME pass. Sector is multi-valued: an
  // object in {military, government} increments both; an unmatched object (no UCS
  // sectors) lands in 'unspecified'. Country keys by the raw operator code so the
  // counts match the render-side country gate exactly (empty '' bucketed as-is).
  const facetCounts = emptyFacetCounts();
  for (const obj of catalogData) {
    categoryCounts[obj.category] = (categoryCounts[obj.category] ?? 0) + 1;
    regimeCounts[obj.regime] = (regimeCounts[obj.regime] ?? 0) + 1;

    facetCounts.type[obj.objectType] += 1;
    facetCounts.status[obj.status] += 1;
    facetCounts.purpose[obj.purpose] += 1;
    if (obj.sectors.length === 0) {
      facetCounts.sector.unspecified += 1;
    } else {
      for (const s of obj.sectors) facetCounts.sector[s] += 1;
    }
    const code = obj.countryCode || 'TBD';
    facetCounts.country[code] = (facetCounts.country[code] ?? 0) + 1;
  }

  return { catalogData, tles, categoryCounts, regimeCounts, facetCounts };
}

interface NetworkCatalog {
  version: string;
  catalogData: EnrichedTLEObject[];
}

async function fetchCatalogFromNetwork(apiUrl: string): Promise<NetworkCatalog> {
  const res = await fetch(`${apiUrl}/api/tle/all`);
  if (!res.ok) throw new Error(`TLE fetch failed: ${res.status}`);
  const response = await res.json();
  return { version: response.version, catalogData: response.data };
}

/**
 * Opportunistic, read-only refresh: ask the lightweight /api/tle/version
 * endpoint whether the catalog changed since the cached copy; if so, download
 * the new one and store it for the NEXT load. Best-effort — swallows all errors
 * and never blocks or hot-swaps the current session. Touches only read-only
 * endpoints, so it cannot influence backend fetching.
 */
async function revalidateCatalogInBackground(apiUrl: string, cachedVersion: string): Promise<void> {
  try {
    const res = await fetch(`${apiUrl}/api/tle/version`);
    if (!res.ok) return;
    const { version } = await res.json();
    if (!version || version === cachedVersion) return; // unchanged — nothing to do
    const fresh = await fetchCatalogFromNetwork(apiUrl);
    await writeCatalogCache({
      version: fresh.version,
      fetchedAt: Date.now(),
      catalogData: fresh.catalogData,
    });
  } catch {
    // Best-effort; the existing cache stays and we retry on the next load.
  }
}

/**
 * Fetch the TLE catalog — no store side effects. Uses an IndexedDB revisit
 * cache (catalog-cache.ts): within CATALOG_MAX_AGE_MS, returns the on-disk copy
 * instantly and refreshes in the background; otherwise downloads fresh and
 * caches it (write is fire-and-forget so it never slows the cold path).
 */
export async function fetchTleCatalog(apiUrl: string): Promise<TleCatalogResult> {
  const cached = await readCatalogCache();
  if (cached && Date.now() - cached.fetchedAt < CATALOG_MAX_AGE_MS) {
    // Warm load — instant render from disk; refresh in the background for next time.
    void revalidateCatalogInBackground(apiUrl, cached.version);
    return buildCatalogResult(cached.catalogData);
  }

  // Cold load (first visit or cache past the staleness ceiling) — fetch fresh.
  const fresh = await fetchCatalogFromNetwork(apiUrl);
  void writeCatalogCache({
    version: fresh.version,
    fetchedAt: Date.now(),
    catalogData: fresh.catalogData,
  });
  return buildCatalogResult(fresh.catalogData);
}

// ── Visual List Poller ────────────────────────────────────────────────────

const VISUAL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class VisualListPoller {
  private readonly apiUrl: string;
  private readonly onResult: (result: VisualListResolvedResult) => void;

  private _visualNoradIds: Set<number> = new Set();
  private etag: string | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    apiUrl: string,
    onResult: (result: VisualListResolvedResult) => void,
  ) {
    this.apiUrl = apiUrl;
    this.onResult = onResult;
  }

  get visualNoradIds(): Set<number> {
    return this._visualNoradIds;
  }

  start(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
    }

    this.interval = setInterval(() => {
      void this.refresh();
    }, VISUAL_REFRESH_INTERVAL_MS);

    // Fire initial refresh non-blocking
    void this.refresh();
  }

  dispose(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return;

    this.inFlight = true;
    try {
      const result = await fetchVisualList({
        apiBase: this.apiUrl,
        etag: this.etag,
      });

      if (result.kind === 'not_modified') return;

      this.etag = result.etag ?? this.etag;
      this._visualNoradIds = result.ids;
      this.onResult(result);
    } catch (err) {
      console.warn('Visual list refresh error:', err);
      const fallback: VisualListResolvedResult = {
        kind: 'resolved',
        ids: new Set(),
        status: 'unavailable',
        source: null,
        stale: false,
        version: null,
        etag: this.etag,
        message: 'Visual list refresh failed unexpectedly.',
      };
      this._visualNoradIds = fallback.ids;
      this.onResult(fallback);
    } finally {
      this.inFlight = false;
    }
  }
}
