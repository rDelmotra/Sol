import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  ensureQueryVocab,
  getRawQueryVocab,
  installQueryVocab,
  resetQueryVocabForTests,
} from './vocab';
import type { QueryVocab } from '../data/query-vocab-client';

const VOCAB: QueryVocab = {
  launches: {
    '2021-005': ['Falcon9', 'Vandenberg', ['SPX']],
    '2022-100': [null, null, []],
  },
  orgs: { SPX: { n: 'SpaceX' } },
  owners: ['SPX'],
};

describe('query vocab install', () => {
  afterEach(() => {
    resetQueryVocabForTests();
  });

  it('starts empty, retains the raw artifact once installed, and resets', () => {
    assert.equal(getRawQueryVocab(), null);
    installQueryVocab(VOCAB);
    assert.equal(getRawQueryVocab(), VOCAB);
    resetQueryVocabForTests();
    assert.equal(getRawQueryVocab(), null);
  });
});

describe('ensureQueryVocab', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetQueryVocabForTests();
  });

  it('fetches once, installs the vocab, and does not refetch', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: true, json: async () => VOCAB } as Response;
    }) as typeof fetch;
    await Promise.all([ensureQueryVocab(), ensureQueryVocab()]);
    await ensureQueryVocab();
    assert.equal(calls, 1);
    assert.deepEqual(getRawQueryVocab(), VOCAB);
  });

  it('leaves the vocab empty on failure and retries on the next call', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false } as Response;
    }) as typeof fetch;
    await ensureQueryVocab();
    assert.equal(getRawQueryVocab(), null);
    await ensureQueryVocab();
    assert.equal(calls, 2);
  });
});
