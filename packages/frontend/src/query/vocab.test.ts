import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  buildVocabIndexes,
  installQueryVocab,
  getVocabIndexes,
  hasQueryVocab,
  resetQueryVocabForTests,
} from './vocab';
import { ALIAS_TABLE, resetAliasTableForTests } from './aliases';
import { parseQuery } from './parser';
import type { QueryVocab } from '../data/query-vocab-client';

const VOCAB: QueryVocab = {
  launches: {
    '2021-005': ['Falcon9', 'Vandenberg'],
    '2021-010': ['Falcon9', 'Canaveral'],
    '2020-001': ['Soyuz', 'Baykonur'],
    '1957 ALP': ['R-7', 'Baykonur'],
    '2022-099': ['UNK', 'Canaveral'],   // UNK family excluded from the index
    '2022-100': [null, null],           // no family/site
  },
  orgs: {
    SPXS: { n: 'SpaceX', a: ['Space Exploration Technologies'] },
    STARC: { n: 'Star Corp' },          // full name registered; 'star' guardrailed
  },
};

describe('buildVocabIndexes', () => {
  it('builds inverted family/site/year maps; excludes UNK; slices year incl. pre-1963', () => {
    const idx = buildVocabIndexes(VOCAB);
    assert.deepEqual(idx.vehicleTags.get('Falcon9'), new Set(['2021-005', '2021-010']));
    assert.equal(idx.vehicleTags.has('UNK'), false);
    assert.deepEqual(idx.siteTags.get('Baykonur'), new Set(['2020-001', '1957 ALP']));
    assert.deepEqual(idx.yearTags.get('2021'), new Set(['2021-005', '2021-010']));
    assert.deepEqual(idx.yearTags.get('1957'), new Set(['1957 ALP']));
    assert.equal(idx.yearTags.has('2022'), true); // 2022-099/100 still counted by year
  });
});

describe('installQueryVocab', () => {
  afterEach(() => {
    resetQueryVocabForTests();
    resetAliasTableForTests();
  });

  it('sets the indexes + hasQueryVocab gate', () => {
    assert.equal(hasQueryVocab(), false);
    installQueryVocab(VOCAB);
    assert.equal(hasQueryVocab(), true);
    assert.ok(getVocabIndexes());
  });

  it('registers vehicle families with camelCase/digit-split variants', () => {
    installQueryVocab(VOCAB);
    assert.deepEqual(parseQuery('falcon 9').matches.map((m) => [m.group, m.value]), [
      ['vehicle', 'Falcon9'],
    ]);
    assert.deepEqual(parseQuery('falcon9').matches.map((m) => [m.group, m.value]), [
      ['vehicle', 'Falcon9'],
    ]);
  });

  it('registers site names + a hand synonym (baikonur → Baykonur)', () => {
    installQueryVocab(VOCAB);
    assert.deepEqual(parseQuery('baikonur').matches.map((m) => [m.group, m.value]), [
      ['site', 'Baykonur'],
    ]);
  });

  it('registers pre-1963 tags as launch aliases (modern tags use the regex)', () => {
    installQueryVocab(VOCAB);
    assert.equal(ALIAS_TABLE.get('1957 alp')!.group, 'launch');
    // A modern tag is NOT a table entry — it comes from the parser pattern rule.
    assert.equal(ALIAS_TABLE.has('2021-005'), false);
  });

  it('org: full display name resolves to its code; generic short word guardrailed', () => {
    installQueryVocab(VOCAB);
    // Full name registered unconditionally.
    assert.deepEqual(parseQuery('star corp').matches.map((m) => [m.group, m.value]), [
      ['owner', 'STARC'],
    ]);
    // The generic single word 'star' must NOT have become an owner alias.
    assert.equal(ALIAS_TABLE.get('star'), undefined);
    // A real variant survives.
    assert.deepEqual(parseQuery('spacex').matches.map((m) => [m.group, m.value]), [
      ['owner', 'SPXS'],
    ]);
  });
});
