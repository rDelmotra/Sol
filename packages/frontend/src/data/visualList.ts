import type { VisualListResponse } from '@orbitwatch/contracts';

const STORAGE_KEY = 'orbitwatch:visualNoradIds:v3';
const REQUEST_TIMEOUT_MS = 8_000;
// Align local fallback cache with backend visual TTL (8h).
const CACHE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export type VisualListStatus = 'loading' | 'fresh' | 'stale' | 'unavailable';
export type VisualListSource = 'celestrak' | 'cache' | 'local_storage' | null;

export interface VisualListResolvedResult {
  kind: 'resolved';
  ids: Set<number>;
  status: Exclude<VisualListStatus, 'loading'>;
  source: VisualListSource;
  stale: boolean;
  version: string | null;
  etag: string | null;
  message: string | null;
}

export interface VisualListNotModifiedResult {
  kind: 'not_modified';
  etag: string | null;
}

export type VisualListFetchResult = VisualListResolvedResult | VisualListNotModifiedResult;

interface VisualNoradCacheEnvelope {
  cachedAt: string;
  ids: number[];
  version: string | null;
  source: Exclude<VisualListSource, null>;
  stale: boolean;
  etag: string | null;
}

interface FetchVisualListOptions {
  apiBase?: string;
  etag?: string | null;
}

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function getTimerApi(): Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> {
  if (typeof window !== 'undefined') {
    return window;
  }
  return globalThis;
}

function toNoradId(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNoradIds(values: unknown[]): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    const parsed = toNoradId(value);
    if (parsed !== null) ids.add(parsed);
  }
  return Array.from(ids).sort((a, b) => a - b);
}

function writeCachedVisualList(result: VisualListResolvedResult): void {
  if (result.status === 'unavailable') {
    return;
  }

  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    const payload: VisualNoradCacheEnvelope = {
      cachedAt: new Date().toISOString(),
      ids: Array.from(result.ids).sort((a, b) => a - b),
      version: result.version,
      source: result.source === 'local_storage' ? 'cache' : (result.source ?? 'cache'),
      stale: result.stale,
      etag: result.etag,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Failed to persist visual NORAD cache:', err);
  }
}

function readCachedVisualListForFallback(): VisualListResolvedResult | null {
  const storage = getStorage();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const envelope = parsed as Partial<VisualNoradCacheEnvelope>;
    if (!Array.isArray(envelope.ids) || typeof envelope.cachedAt !== 'string') return null;

    const cachedAtMs = Date.parse(envelope.cachedAt);
    if (!Number.isFinite(cachedAtMs) || Date.now() - cachedAtMs > CACHE_MAX_AGE_MS) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }

    const ids = normalizeNoradIds(envelope.ids);
    if (ids.length === 0) return null;

    return {
      kind: 'resolved',
      ids: new Set(ids),
      status: 'stale',
      source: 'local_storage',
      stale: true,
      version: typeof envelope.version === 'string' ? envelope.version : null,
      etag: typeof envelope.etag === 'string' ? envelope.etag : null,
      message: 'Using local cached visual list due to backend fetch failure.',
    };
  } catch (err) {
    console.warn('Failed to read visual NORAD cache:', err);
    return null;
  }
}

export function parseVisualListResponse(
  payload: unknown,
  etag: string | null,
): VisualListResolvedResult {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Visual endpoint returned invalid payload');
  }

  const body = payload as Partial<VisualListResponse>;
  if (!Array.isArray(body.ids)) {
    throw new Error('Visual endpoint payload missing ids[]');
  }

  const ids = normalizeNoradIds(body.ids);
  if (ids.length === 0) {
    throw new Error('Visual endpoint returned no NORAD IDs');
  }

  const stale = body.stale === true;
  const source =
    body.source === 'celestrak' || body.source === 'cache'
      ? body.source
      : null;
  const version = typeof body.version === 'string' ? body.version : null;

  return {
    kind: 'resolved',
    ids: new Set(ids),
    status: stale ? 'stale' : 'fresh',
    source,
    stale,
    version,
    etag: etag ?? (version ? `"${version}"` : null),
    message: stale ? 'Using stale backend visual cache.' : null,
  };
}

export async function fetchVisualList(
  options: FetchVisualListOptions = {},
): Promise<VisualListFetchResult> {
  const apiBase = options.apiBase ?? (import.meta.env?.VITE_API_URL ?? '');
  const controller = new AbortController();
  const timerApi = getTimerApi();
  const timeoutId = timerApi.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: HeadersInit = {};
    if (options.etag) {
      headers['If-None-Match'] = options.etag;
    }

    const res = await fetch(`${apiBase}/api/tle/visual`, {
      signal: controller.signal,
      headers,
      cache: 'no-store',
    });

    if (res.status === 304) {
      return {
        kind: 'not_modified',
        etag: options.etag ?? null,
      };
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = (await res.json()) as unknown;
    const parsed = parseVisualListResponse(payload, res.headers.get('ETag'));
    writeCachedVisualList(parsed);
    return parsed;
  } catch (err) {
    const cached = readCachedVisualListForFallback();
    if (cached) {
      return cached;
    }

    const reason = err instanceof Error ? err.message : 'unknown error';
    return {
      kind: 'resolved',
      ids: new Set(),
      status: 'unavailable',
      source: null,
      stale: false,
      version: null,
      etag: options.etag ?? null,
      message: `Visual list unavailable: ${reason}`,
    };
  } finally {
    timerApi.clearTimeout(timeoutId);
  }
}
