import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReplayClient } from './replay-client';
import type { ReplayDiskCache } from './replay-cache';
import type { HistoryCatalogResponse } from './replay-types';
import { histObj } from './replay-fixtures';

const body = (day: string): HistoryCatalogResponse => ({ day, accuracy: null, objects: [histObj(1), histObj(2)] });

function fakeFetch(handler: (url: string) => { status: number; json?: unknown }) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const r = handler(url);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as Response;
  };
  return { impl, calls };
}

function memDisk(): ReplayDiskCache & { store: Map<string, HistoryCatalogResponse>; writes: string[] } {
  const store = new Map<string, HistoryCatalogResponse>();
  const writes: string[] = [];
  return {
    store,
    writes,
    read: async (d) => store.get(d) ?? null,
    write: async (d, b) => {
      writes.push(d);
      store.set(d, b);
    },
  };
}

const catalogHandler = (url: string) => {
  const m = /catalog\?day=(\d{4}-\d{2}-\d{2})/.exec(url);
  return m ? { status: 200, json: body(m[1]) } : { status: 404 };
};

describe('replay client — catalog cache + prefetch', () => {
  it('serves a day from memory after the first fetch and shares a request in flight', async () => {
    const f = fakeFetch(catalogHandler);
    const disk = memDisk();
    const c = createReplayClient({ apiUrl: 'http://x', fetchImpl: f.impl, disk });
    const [a, b] = await Promise.all([c.catalog('1998-11-20'), c.catalog('1998-11-20')]);
    assert.equal(a, b);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0], 'http://x/api/history/catalog?day=1998-11-20');
    assert.ok(c.hasInMemory('1998-11-20'));
    await c.catalog('1998-11-20');
    assert.equal(f.calls.length, 1, 'memory hit');
    assert.deepEqual(disk.writes, ['1998-11-20'], 'written to disk once');
  });

  it('reads the disk cache before the network', async () => {
    const f = fakeFetch(catalogHandler);
    const disk = memDisk();
    disk.store.set('1965-06-05', body('1965-06-05'));
    const c = createReplayClient({ apiUrl: '', fetchImpl: f.impl, disk });
    const r = await c.catalog('1965-06-05');
    assert.equal(r?.day, '1965-06-05');
    assert.equal(f.calls.length, 0);
  });

  it('prefetch warms the next day so the midnight swap is a memory hit; LRU keeps memoryDays', async () => {
    const f = fakeFetch(catalogHandler);
    const c = createReplayClient({ apiUrl: '', fetchImpl: f.impl, disk: memDisk(), memoryDays: 2 });
    await c.catalog('2009-02-10');
    c.prefetch('2009-02-11');
    c.prefetch('2009-02-11'); // deduped while in flight
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(f.calls.length, 2);
    assert.ok(c.hasInMemory('2009-02-11'));
    await c.catalog('2009-02-11');
    assert.equal(f.calls.length, 2, 'swap reads the prefetched day');
    await c.catalog('2009-02-12');
    assert.ok(!c.hasInMemory('2009-02-10'), 'oldest evicted');
    assert.ok(c.hasInMemory('2009-02-11') && c.hasInMemory('2009-02-12'));
  });

  it('rejects malformed days without a request', async () => {
    const f = fakeFetch(catalogHandler);
    const c = createReplayClient({ apiUrl: '', fetchImpl: f.impl, disk: memDisk() });
    assert.equal(await c.catalog('1998-11'), null);
    assert.equal(f.calls.length, 0);
  });
});

describe('replay client — 503 fallback (archive not configured)', () => {
  it('range, catalog, timeline and events are all null, never a throw', async () => {
    const f = fakeFetch(() => ({ status: 503, json: { error: 'History is not available.' } }));
    const c = createReplayClient({ apiUrl: '', fetchImpl: f.impl, disk: memDisk() });
    assert.equal(await c.range(), null);
    assert.equal(await c.catalog('1998-11-20'), null);
    assert.equal(await c.timeline('1959-01-11', '2026-03-31', 'year'), null);
    assert.equal(await c.events({ from: '1998-11-20', to: '1998-11-20' }), null);
  });
  it('a network failure is null as well', async () => {
    const c = createReplayClient({ apiUrl: '', fetchImpl: async () => { throw new Error('offline'); }, disk: memDisk() });
    assert.equal(await c.range(), null);
    assert.equal(await c.catalog('1998-11-20'), null);
  });
  it('range is validated', async () => {
    const ok = createReplayClient({
      apiUrl: '',
      disk: memDisk(),
      fetchImpl: fakeFetch(() => ({ status: 200, json: { firstDay: '1959-01-11', lastDay: '2026-03-31', days: 24552, eventsFirstDay: null, eventsLastDay: null, hasCoverage: true } })).impl,
    });
    assert.equal((await ok.range())?.lastDay, '2026-03-31');
    const bad = createReplayClient({ apiUrl: '', disk: memDisk(), fetchImpl: fakeFetch(() => ({ status: 200, json: { firstDay: 'x' } })).impl });
    assert.equal(await bad.range(), null);
  });
});

describe('replay client — timeline and events', () => {
  it('passes the query and caches per query', async () => {
    const f = fakeFetch((url) =>
      url.includes('/timeline')
        ? { status: 200, json: [{ t: '1998', counts: { 'object.appeared': 3 } }, { bad: true }] }
        : { status: 200, json: { count: 1, events: [{ id: 1, day: '1998-11-20', kind: 'object.appeared', subjects: [25544], tStart: null, tEnd: null, payload: {} }] } },
    );
    const c = createReplayClient({ apiUrl: '', fetchImpl: f.impl, disk: memDisk() });
    const t = await c.timeline('1959-01-11', '2026-03-31', 'year', ['object.appeared', 'object.breakup']);
    assert.equal(t?.length, 1);
    assert.match(f.calls[0], /\/api\/history\/timeline\?from=1959-01-11&to=2026-03-31&bucket=year&kinds=object.appeared%2Cobject.breakup/);
    await c.timeline('1959-01-11', '2026-03-31', 'year', ['object.appeared', 'object.breakup']);
    assert.equal(f.calls.length, 1);
    const e = await c.events({ from: '1998-11-20', to: '1998-11-20', limit: 500 });
    assert.equal(e?.[0].subjects[0], 25544);
    assert.match(f.calls[1], /\/api\/ssa\/events\?from=1998-11-20&to=1998-11-20&limit=500/);
  });
});
