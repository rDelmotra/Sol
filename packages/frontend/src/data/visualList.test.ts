import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  fetchVisualList,
  parseVisualListResponse,
} from './visualList';

const STORAGE_KEY = 'orbitwatch:visualNoradIds:v3';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string): string | null {
      return map.has(key) ? map.get(key) ?? null : null;
    },
    key(index: number): string | null {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
  };
}

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as Record<string, unknown>).window;
const originalLocalStorage = (globalThis as Record<string, unknown>).localStorage;

beforeEach(() => {
  (globalThis as Record<string, unknown>).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  (globalThis as Record<string, unknown>).localStorage = createMemoryStorage();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as Record<string, unknown>).window = originalWindow;
  (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
});

describe('parseVisualListResponse', () => {
  it('parses backend visual payload with metadata', () => {
    const parsed = parseVisualListResponse(
      {
        version: '2026-04-10T04:00:00.000Z',
        ids: [25544, '20580', 25544],
        source: 'celestrak',
        stale: false,
      },
      '"2026-04-10T04:00:00.000Z"',
    );

    assert.equal(parsed.kind, 'resolved');
    assert.equal(parsed.status, 'fresh');
    assert.equal(parsed.source, 'celestrak');
    assert.equal(parsed.stale, false);
    assert.equal(parsed.version, '2026-04-10T04:00:00.000Z');
    assert.equal(parsed.etag, '"2026-04-10T04:00:00.000Z"');
    assert.deepEqual(Array.from(parsed.ids), [20580, 25544]);
  });
});

describe('fetchVisualList', () => {
  it('returns not_modified on 304 with prior etag', async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 304 })) as typeof fetch;

    const result = await fetchVisualList({
      apiBase: 'http://localhost:3001',
      etag: '"etag-1"',
    });

    assert.deepEqual(result, { kind: 'not_modified', etag: '"etag-1"' });
  });

  it('falls back to local cache as stale when fetch fails', async () => {
    const storage = (globalThis as Record<string, unknown>).localStorage as Storage;
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        cachedAt: new Date().toISOString(),
        ids: [25544, 28654],
        version: '2026-04-10T05:00:00.000Z',
        source: 'cache',
        stale: false,
        etag: '"2026-04-10T05:00:00.000Z"',
      }),
    );

    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const result = await fetchVisualList({ apiBase: 'http://localhost:3001' });
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') {
      assert.equal(result.status, 'stale');
      assert.equal(result.source, 'local_storage');
      assert.equal(result.stale, true);
      assert.equal(result.version, '2026-04-10T05:00:00.000Z');
      assert.deepEqual(Array.from(result.ids), [25544, 28654]);
    }
  });

  it('returns unavailable when fetch fails and no cache exists', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const result = await fetchVisualList({ apiBase: 'http://localhost:3001' });
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') {
      assert.equal(result.status, 'unavailable');
      assert.equal(result.source, null);
      assert.equal(result.ids.size, 0);
      assert.ok(result.message?.includes('network down'));
    }
  });
});
