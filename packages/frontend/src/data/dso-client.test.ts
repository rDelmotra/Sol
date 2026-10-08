// dso-client delivers data through an injected DsoSink (no store import).
// fetch is mocked; a recording sink captures every delivery.

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { initDsoClient, stopDsoClient, type DsoSink } from './dso-client';

const realFetch = globalThis.fetch;

function entry(dsoId: string, availability: boolean) {
  return {
    dsoId,
    slug: dsoId,
    displayName: `Name ${dsoId}`,
    mission: 'm',
    targetBody: 'moon',
    regime: 'LUNAR',
    provider: 'horizons',
    freshnessState: 'fresh',
    searchAliases: [],
    availability,
    currentSnapshotVersion: availability ? 'v1' : null,
  };
}

function snapshot(dsoId: string) {
  return { dsoId, snapshotVersion: 'v1' };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ETag: '"e"' } });
}

function recordingSink() {
  const calls: Array<[string, unknown]> = [];
  const sink: DsoSink = {
    setObjects: (o) => calls.push(['objects', o.map((x) => x.dsoId)]),
    setEphemeris: (id) => calls.push(['ephemeris', id]),
  };
  return { sink, calls };
}

afterEach(() => {
  stopDsoClient();
  globalThis.fetch = realFetch;
});

describe('dso-client sink delivery', () => {
  it('delivers only available entries as objects, then ephemeris per entry in catalog order', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/dso/catalog')) {
        return json({ objects: [entry('a', true), entry('off', false), entry('b', true)] });
      }
      const m = url.match(/ephemeris\/(.+)$/);
      if (m) return json(snapshot(m[1]));
      return json({}, 503);
    }) as typeof fetch;

    const { sink, calls } = recordingSink();
    await initDsoClient(sink);
    assert.deepEqual(calls, [
      ['objects', ['a', 'b']],
      ['ephemeris', 'a'],
      ['ephemeris', 'b'],
    ]);
  });

  it('makes no sink calls when the catalog returns 503', async () => {
    globalThis.fetch = (async () => json({}, 503)) as typeof fetch;
    const { sink, calls } = recordingSink();
    await initDsoClient(sink);
    assert.deepEqual(calls, []);
  });

  it('makes no later sink calls when stopped while ephemeris is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/dso/catalog')) return json({ objects: [entry('a', true)] });
      await gate;
      return json(snapshot('a'));
    }) as typeof fetch;

    const { sink, calls } = recordingSink();
    const p = initDsoClient(sink);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(calls, [['objects', ['a']]]);
    stopDsoClient();
    release();
    await p;
    assert.deepEqual(calls, [['objects', ['a']]]);
  });
});
