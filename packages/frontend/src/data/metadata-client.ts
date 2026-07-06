// ============================================================
// metadata-client.ts — lazy per-object metadata fetcher
//
// GET /api/metadata/:noradId → full ObjectMetadata (GCAT + UCS join), served
// from the backend's boot-loaded store. Heavy specs stay OUT of the hot
// /api/tle/all payload; the InfoCard fetches them on selection. Results are
// memo-cached for the session (the artifact only changes on redeploy);
// 404 (no record) caches as null.
// ============================================================

import type { ObjectMetadataResponse } from './metadata-types';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

const cache = new Map<number, ObjectMetadataResponse | null>();

export async function fetchObjectMetadata(
  noradId: number,
): Promise<ObjectMetadataResponse | null> {
  if (cache.has(noradId)) return cache.get(noradId) ?? null;
  try {
    const res = await fetch(`${API_BASE}/api/metadata/${noradId}`);
    if (!res.ok) {
      if (res.status === 404) cache.set(noradId, null);
      return null;
    }
    const meta = (await res.json()) as ObjectMetadataResponse;
    cache.set(noradId, meta);
    return meta;
  } catch {
    return null; // transient failure — do not negative-cache
  }
}
