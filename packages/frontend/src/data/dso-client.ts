import type { DsoCatalog, DsoCatalogEntry, DsoManifest, DsoSnapshot } from '@orbitwatch/contracts';
import type { DsoObject } from './dso-types';

/** Where the client delivers data; keeps `data/` free of any store import. */
export interface DsoSink {
  setObjects(o: DsoObject[]): void;
  setEphemeris(id: string, s: DsoSnapshot): void;
}

const API_BASE = import.meta.env?.VITE_API_URL ?? '';
const MANIFEST_POLL_MS = 60 * 1000;
const CATALOG_BOOTSTRAP_POLL_MS = 5 * 1000;

/**
 * Tracks per-DSO snapshot versions so we only re-fetch ephemeris when
 * the backend publishes a new snapshot.
 */
const knownVersions = new Map<string, string>();
const ephemerisEtags = new Map<string, string>();
let catalogEtag: string | null = null;
let manifestEtag: string | null = null;
let cachedCatalog: DsoCatalog | null = null;
let cachedManifest: DsoManifest | null = null;
const cachedEphemeris = new Map<string, DsoSnapshot>();

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollIntervalMs = MANIFEST_POLL_MS;
// Bumped by stopDsoClient(); lets an in-flight initDsoClient() detect that the
// session was torn down (Engine disposed / StrictMode remount) while it was
// awaiting fetches, so it won't write the store or restart polling afterward.
let generation = 0;

function catalogEntryToDsoObject(entry: DsoCatalogEntry): DsoObject {
  return {
    source: 'dso',
    dsoId: entry.dsoId,
    slug: entry.slug,
    name: entry.displayName,
    mission: entry.mission,
    targetBody: entry.targetBody,
    regime: entry.regime,
    provider: entry.provider,
    freshnessState: entry.freshnessState,
    searchAliases: entry.searchAliases,
  };
}

async function fetchCatalog(): Promise<DsoCatalog | null> {
  try {
    const url = `${API_BASE}/api/dso/catalog`;
    const headers: HeadersInit = {};
    if (catalogEtag) headers['If-None-Match'] = catalogEtag;

    const res = await fetch(url, { headers, cache: 'no-store' });
    if (res.status === 503) return null;
    if (res.status === 304) {
      if (cachedCatalog) return cachedCatalog;

      const retry = await fetch(url, { cache: 'no-store' });
      if (retry.status === 503) return null;
      if (!retry.ok) throw new Error(`DSO catalog fetch failed: ${retry.status}`);
      catalogEtag = retry.headers.get('ETag') ?? catalogEtag;
      const catalog = (await retry.json()) as DsoCatalog;
      cachedCatalog = catalog;
      return catalog;
    }
    if (!res.ok) throw new Error(`DSO catalog fetch failed: ${res.status}`);
    catalogEtag = res.headers.get('ETag') ?? catalogEtag;
    const catalog = (await res.json()) as DsoCatalog;
    cachedCatalog = catalog;
    return catalog;
  } catch (err) {
    console.warn('DSO catalog fetch error:', err);
    return null;
  }
}

async function fetchEphemeris(dsoId: string): Promise<DsoSnapshot | null> {
  try {
    const url = `${API_BASE}/api/dso/ephemeris/${dsoId}`;
    const headers: HeadersInit = {};
    const etag = ephemerisEtags.get(dsoId);
    if (etag) headers['If-None-Match'] = etag;

    const res = await fetch(url, { headers, cache: 'no-store' });
    if (res.status === 503 || res.status === 404) return null;
    if (res.status === 304) return cachedEphemeris.get(dsoId) ?? null;
    if (!res.ok) throw new Error(`DSO ephemeris fetch failed for ${dsoId}: ${res.status}`);
    const snapshot = (await res.json()) as DsoSnapshot;
    ephemerisEtags.set(dsoId, res.headers.get('ETag') ?? `"${snapshot.snapshotVersion}"`);
    cachedEphemeris.set(dsoId, snapshot);
    return snapshot;
  } catch (err) {
    console.warn(`DSO ephemeris fetch error (${dsoId}):`, err);
    return null;
  }
}

async function fetchManifest(): Promise<DsoManifest | null> {
  try {
    const url = `${API_BASE}/api/dso/manifest`;
    const headers: HeadersInit = {};
    if (manifestEtag) headers['If-None-Match'] = manifestEtag;

    const res = await fetch(url, { headers, cache: 'no-store' });
    if (res.status === 503) return null;
    if (res.status === 304) {
      if (cachedManifest) return cachedManifest;

      const retry = await fetch(url, { cache: 'no-store' });
      if (retry.status === 503) return null;
      if (!retry.ok) throw new Error(`DSO manifest fetch failed: ${retry.status}`);
      manifestEtag = retry.headers.get('ETag') ?? manifestEtag;
      const manifest = (await retry.json()) as DsoManifest;
      cachedManifest = manifest;
      return manifest;
    }
    if (!res.ok) throw new Error(`DSO manifest fetch failed: ${res.status}`);
    manifestEtag = res.headers.get('ETag') ?? manifestEtag;
    const manifest = (await res.json()) as DsoManifest;
    cachedManifest = manifest;
    return manifest;
  } catch (err) {
    console.warn('DSO manifest fetch error:', err);
    return null;
  }
}

async function loadAllEphemeris(sink: DsoSink, entries: DsoCatalogEntry[], myGen: number): Promise<void> {
  for (const entry of entries) {
    if (!entry.availability || !entry.currentSnapshotVersion) continue;
    const snapshot = await fetchEphemeris(entry.dsoId);
    if (generation !== myGen) return; // torn down mid-load — stop mutating store
    if (snapshot) {
      sink.setEphemeris(entry.dsoId, snapshot);
      knownVersions.set(entry.dsoId, snapshot.snapshotVersion);
    }
  }
}

/**
 * Poll the manifest endpoint. If any DSO's snapshotVersion changed,
 * re-fetch its ephemeris and update the store.
 */
async function pollManifest(sink: DsoSink, myGen: number): Promise<void> {
  const manifest = await fetchManifest();
  if (generation !== myGen || !manifest) return;

  for (const [dsoId, status] of Object.entries(manifest.objects)) {
    if (!status.enabled || !status.availability || !status.currentSnapshotVersion) continue;

    const known = knownVersions.get(dsoId);
    if (known === status.currentSnapshotVersion) continue;

    // Version changed — re-fetch
    const snapshot = await fetchEphemeris(dsoId);
    if (generation !== myGen) return; // torn down mid-poll — stop mutating store
    if (snapshot) {
      sink.setEphemeris(dsoId, snapshot);
      knownVersions.set(dsoId, snapshot.snapshotVersion);
    }
  }
}

/**
 * Initialize DSO data pipeline: fetch catalog, load all ephemeris,
 * then start manifest polling. Call once from the app layer after
 * TLE loading is complete (or in parallel).
 */
export async function initDsoClient(sink: DsoSink): Promise<void> {
  const myGen = generation;
  const catalog = await fetchCatalog();
  if (generation !== myGen) return; // torn down during fetch — abort
  if (!catalog || catalog.objects.length === 0) {
    console.log('DSO: no catalog available yet, will retry on next poll');
    pollIntervalMs = CATALOG_BOOTSTRAP_POLL_MS;
    // Start polling even if catalog isn't ready — worker may still be starting
    startPolling(sink);
    return;
  }

  const dsoObjects = catalog.objects
    .filter((e) => e.availability)
    .map(catalogEntryToDsoObject);

  sink.setObjects(dsoObjects);

  await loadAllEphemeris(sink, catalog.objects, myGen);
  if (generation !== myGen) return; // torn down during ephemeris load — abort
  pollIntervalMs = MANIFEST_POLL_MS;
  startPolling(sink);
}

function startPolling(sink: DsoSink): void {
  if (pollTimer) return;
  const myGen = generation;
  pollTimer = setTimeout(async function poll() {
    try {
      // Re-fetch catalog to pick up newly enabled DSOs
      const catalog = await fetchCatalog();
      if (generation !== myGen) return; // torn down mid-poll — stop
      if (catalog && catalog.objects.length > 0) {
        pollIntervalMs = MANIFEST_POLL_MS;
        const dsoObjects = catalog.objects
          .filter((e) => e.availability)
          .map(catalogEntryToDsoObject);

        sink.setObjects(dsoObjects);
      } else {
        pollIntervalMs = CATALOG_BOOTSTRAP_POLL_MS;
      }

      await pollManifest(sink, myGen);
    } catch (err) {
      console.warn('DSO poll error:', err);
    }

    if (pollTimer !== null && generation === myGen) {
      pollTimer = setTimeout(poll, pollIntervalMs);
    }
  }, pollIntervalMs);
}

export function stopDsoClient(): void {
  generation++; // invalidate any in-flight initDsoClient()
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  knownVersions.clear();
  ephemerisEtags.clear();
  cachedEphemeris.clear();
  catalogEtag = null;
  manifestEtag = null;
  cachedCatalog = null;
  cachedManifest = null;
  pollIntervalMs = MANIFEST_POLL_MS;
}
