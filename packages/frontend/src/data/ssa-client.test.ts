import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearSsaCache, fetchObjectEncounters, RUN_TTL_MS } from './ssa-client';
import { encountersFixture, runFixture } from './ssa-fixtures';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearSsaCache();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mockApi(handlers: { run?: () => Response; object?: () => Response }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/ssa/run')) return handlers.run ? handlers.run() : json(runFixture());
    return handlers.object ? handlers.object() : json(encountersFixture(25544));
  }) as typeof fetch;
  return calls;
}

describe('ssa-client', () => {
  it('returns the object\'s encounters', async () => {
    mockApi({});
    const r = await fetchObjectEncounters(25544);
    assert.equal(r.kind, 'ok');
    assert.equal(r.kind === 'ok' && r.data.encounters.length, 2);
  });

  it('caches per (norad, run): a second call makes no request', async () => {
    const calls = mockApi({});
    await fetchObjectEncounters(25544);
    const n = calls.length;
    await fetchObjectEncounters(25544);
    assert.equal(calls.length, n);
    await fetchObjectEncounters(40000); // different object -> one more request, run id reused
    assert.equal(calls.length, n + 1);
  });

  it('asks for the run again after the TTL, and refetches when the run id changed', async () => {
    let runId = 1;
    const calls = mockApi({
      run: () => json(runFixture(runId)),
      object: () => json(encountersFixture(25544, runId)),
    });
    await fetchObjectEncounters(25544, 1_000);
    runId = 2;
    await fetchObjectEncounters(25544, 1_000 + RUN_TTL_MS + 1);
    assert.equal(calls.filter((c) => c.endsWith('/api/ssa/run')).length, 2);
    assert.equal(calls.filter((c) => c.includes('/objects/')).length, 2);
  });

  it('shares a request in flight', async () => {
    const calls = mockApi({});
    await Promise.all([fetchObjectEncounters(25544), fetchObjectEncounters(25544)]);
    assert.equal(calls.filter((c) => c.includes('/objects/')).length, 1);
  });

  it('404 is "none" and 503 is "unavailable", not errors', async () => {
    mockApi({ run: () => json({ error: 'no run' }, 404) });
    assert.equal((await fetchObjectEncounters(1)).kind, 'none');
    clearSsaCache();
    mockApi({ run: () => json({ error: 'off' }, 503) });
    assert.equal((await fetchObjectEncounters(1)).kind, 'unavailable');
    clearSsaCache();
    mockApi({ object: () => json({ error: 'off' }, 503) });
    assert.equal((await fetchObjectEncounters(1)).kind, 'unavailable');
  });

  it('network failure is an error result, not a throw', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const r = await fetchObjectEncounters(1);
    assert.deepEqual(r, { kind: 'error', message: 'offline' });
  });
});
