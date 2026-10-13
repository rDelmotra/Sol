import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { startCatalogPrefetch, takeCatalogPrefetch } from './catalog-prefetch';
import type { TleCatalogResult } from './tle-client';
import { emptyFacetCounts } from './types';

function emptyResult(): TleCatalogResult {
  return {
    catalogData: [],
    tles: [],
    categoryCounts: { active_satellite: 0, inactive_satellite: 0, rocket_body: 0, debris: 0, unknown: 0, deep_space: 0 },
    regimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },
    facetCounts: emptyFacetCounts(),
  };
}

describe('catalog prefetch', () => {
  // Module state: drain anything a test left behind.
  afterEach(() => { takeCatalogPrefetch('http://api.test'); takeCatalogPrefetch('http://other.test'); });

  it('starts one request and hands that same request to the first taker only', async () => {
    let calls = 0;
    const result = emptyResult();
    const fetcher = async () => { calls++; return result; };

    startCatalogPrefetch('http://api.test', fetcher);
    startCatalogPrefetch('http://api.test', fetcher); // second start is ignored
    assert.equal(calls, 1);

    const taken = takeCatalogPrefetch('http://api.test');
    assert.ok(taken);
    assert.equal(await taken, result);
    assert.equal(takeCatalogPrefetch('http://api.test'), null, 'already taken');
  });

  it('returns null when nothing was started', () => {
    assert.equal(takeCatalogPrefetch('http://api.test'), null);
  });

  it('does not hand a request made for another API base to this caller', () => {
    startCatalogPrefetch('http://api.test', async () => emptyResult());
    assert.equal(takeCatalogPrefetch('http://other.test'), null);
    assert.ok(takeCatalogPrefetch('http://api.test'), 'still waiting for its own taker');
  });

  it('passes a failure to the taker without raising an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => { seen.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      startCatalogPrefetch('http://api.test', async () => { throw new Error('catalog down'); });
      await new Promise<void>((r) => setImmediate(r)); // let the failure land before anyone takes it
      await assert.rejects(takeCatalogPrefetch('http://api.test')!, /catalog down/);
      await new Promise<void>((r) => setImmediate(r));
      assert.deepEqual(seen, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('after a failed request is taken, a new start makes a fresh request', async () => {
    startCatalogPrefetch('http://api.test', async () => { throw new Error('first'); });
    await assert.rejects(takeCatalogPrefetch('http://api.test')!);
    assert.equal(takeCatalogPrefetch('http://api.test'), null);

    const second = emptyResult();
    startCatalogPrefetch('http://api.test', async () => second);
    assert.equal(await takeCatalogPrefetch('http://api.test')!, second);
  });
});
