import type { VisualDataSource, VisualListResponse } from '@orbitwatch/contracts';

export type { VisualDataSource };

export interface VisualCacheSnapshot {
  version: string;
  ids: number[];
}

interface VisualResolveOk {
  kind: 'ok';
  payload: VisualCacheSnapshot;
  source: VisualDataSource;
  stale: boolean;
  refreshError: string | null;
}

interface VisualResolveError {
  kind: 'error';
  message: string;
}

export type VisualResolveResult = VisualResolveOk | VisualResolveError;

export function buildVisualEndpointResponse(
  payload: VisualCacheSnapshot,
  source: VisualDataSource,
  stale: boolean,
): VisualListResponse {
  return {
    version: payload.version,
    count: payload.ids.length,
    ids: payload.ids,
    source,
    stale,
  } satisfies VisualListResponse;
}

export async function resolveVisualPayload(
  cached: VisualCacheSnapshot | null,
  cachedFresh: boolean,
  refresh: () => Promise<VisualCacheSnapshot>,
): Promise<VisualResolveResult> {
  if (cached && cachedFresh) {
    return {
      kind: 'ok',
      payload: cached,
      source: 'cache',
      stale: false,
      refreshError: null,
    };
  }

  try {
    const fresh = await refresh();
    return {
      kind: 'ok',
      payload: fresh,
      source: 'celestrak',
      stale: false,
      refreshError: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    if (cached) {
      return {
        kind: 'ok',
        payload: cached,
        source: 'cache',
        stale: true,
        refreshError: message,
      };
    }

    return {
      kind: 'error',
      message,
    };
  }
}
