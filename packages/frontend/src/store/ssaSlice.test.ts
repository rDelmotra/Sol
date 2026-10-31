import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useStore } from './useStore';
import { clearSsaCache } from '../data/ssa-client';
import { encountersFixture, runFixture } from '../data/ssa-fixtures';

const realFetch = globalThis.fetch;
const initial = useStore.getState();

afterEach(() => {
  globalThis.fetch = realFetch;
  clearSsaCache();
  useStore.setState(initial, true);
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mockApi(objectStatus = 200, runStatus = 200) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/ssa/run')) return json(runStatus === 200 ? runFixture() : { error: 'x' }, runStatus);
    return json(objectStatus === 200 ? encountersFixture(25544) : { error: 'x' }, objectStatus);
  }) as typeof fetch;
  return calls;
}

describe('ssaSlice', () => {
  it('starts empty', () => {
    const s = useStore.getState();
    assert.deepEqual(s.encountersByNorad, {});
    assert.deepEqual(s.encounterStatusByNorad, {});
    assert.equal(s.selectedEncounterId, null);
  });

  it('loadEncounters stores the list sorted by TCA and marks ready (loading on the way)', async () => {
    mockApi();
    const p = useStore.getState().loadEncounters(25544);
    assert.equal(useStore.getState().encounterStatusByNorad[25544], 'loading');
    await p;
    const s = useStore.getState();
    assert.equal(s.encounterStatusByNorad[25544], 'ready');
    assert.deepEqual(s.encountersByNorad[25544].map((e) => e.id), [10, 11]);
  });

  it('does not request again once loaded', async () => {
    const calls = mockApi();
    await useStore.getState().loadEncounters(25544);
    const n = calls.length;
    await useStore.getState().loadEncounters(25544);
    assert.equal(calls.length, n);
  });

  it('404 means an empty, ready list; 503 means unavailable', async () => {
    mockApi(200, 404);
    await useStore.getState().loadEncounters(1);
    assert.equal(useStore.getState().encounterStatusByNorad[1], 'ready');
    assert.deepEqual(useStore.getState().encountersByNorad[1], []);
    clearSsaCache();
    mockApi(200, 503);
    await useStore.getState().loadEncounters(2);
    assert.equal(useStore.getState().encounterStatusByNorad[2], 'unavailable');
    assert.equal(useStore.getState().encountersByNorad[2], undefined);
  });

  it('a network error is recorded and can be retried', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await useStore.getState().loadEncounters(3);
    assert.equal(useStore.getState().encounterStatusByNorad[3], 'error');
    mockApi();
    await useStore.getState().loadEncounters(3);
    assert.equal(useStore.getState().encounterStatusByNorad[3], 'ready');
  });

  it('selectEncounter sets and clears the id', () => {
    useStore.getState().selectEncounter(10);
    assert.equal(useStore.getState().selectedEncounterId, 10);
    useStore.getState().selectEncounter(null);
    assert.equal(useStore.getState().selectedEncounterId, null);
  });
});
