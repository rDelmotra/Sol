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
    '2021-005': ['Falcon9', 'Vandenberg', ['SPX']],
    '2021-010': ['Falcon9', 'Canaveral', ['SPX']],
    '2020-001': ['Soyuz', 'Baykonur', ['RVSNR']],
    '1957 ALP': ['R-7', 'Baykonur', []],
    '2022-099': ['UNK', 'Canaveral', ['ARIA']],   // UNK family excluded from the index
    '2022-100': [null, null, []],                 // no family/site/agency
  },
  orgs: {
    SPXS: { n: 'SpaceX/Seattle', a: ['SpaceX (Seattle)'] }, // owner, shares 'spacex'
    SPX: { n: 'SpaceX' },                                   // owner + agency, shares 'spacex'
    STARC: { n: 'Star Corp' },                              // owner; 'star' guardrailed
    ARIA: { n: 'Arianespace' },                             // agency-only (owns nothing)
  },
  owners: ['SPX', 'SPXS', 'STARC'],
};

describe('buildVocabIndexes', () => {
  it('builds inverted family/site/year maps + agency-code→tags; excludes UNK', () => {
    const idx = buildVocabIndexes(VOCAB);
    assert.deepEqual(idx.vehicleTags.get('Falcon9'), new Set(['2021-005', '2021-010']));
    assert.equal(idx.vehicleTags.has('UNK'), false);
    assert.deepEqual(idx.siteTags.get('Baykonur'), new Set(['2020-001', '1957 ALP']));
    assert.deepEqual(idx.yearTags.get('2021'), new Set(['2021-005', '2021-010']));
    assert.deepEqual(idx.yearTags.get('1957'), new Set(['1957 ALP']));
    assert.deepEqual(idx.agencyCodeToTags.get('SPX'), new Set(['2021-005', '2021-010']));
    assert.deepEqual(idx.agencyCodeToTags.get('ARIA'), new Set(['2022-099']));
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
    assert.equal(ALIAS_TABLE.has('2021-005'), false);
  });

  it('owner name resolves to a name-key; generic short word guardrailed', () => {
    installQueryVocab(VOCAB);
    // Full name registered unconditionally → owner group, value = name-key.
    assert.deepEqual(parseQuery('star corp').matches.map((m) => [m.group, m.value]), [
      ['owner', 'star corp'],
    ]);
    // The generic single word 'star' must NOT have become an owner alias.
    assert.equal(ALIAS_TABLE.get('star'), undefined);
    // Shared token 'spacex' resolves to the owner group (value = name-key).
    assert.deepEqual(parseQuery('spacex').matches.map((m) => [m.group, m.value]), [
      ['owner', 'spacex'],
    ]);
  });

  it('owner family: shared name token unions all producing owners (SPX + SPXS)', () => {
    installQueryVocab(VOCAB);
    const idx = getVocabIndexes()!;
    assert.deepEqual(idx.ownerCodes.get('spacex'), new Set(['SPX', 'SPXS']));
    // The SPXS-specific derived key stays specific.
    assert.deepEqual(idx.ownerCodes.get('seattle'), new Set(['SPXS']));
  });

  it('owner family: parent tree pulls descendants under the root name', () => {
    installQueryVocab({
      launches: {},
      orgs: {
        NASA: { n: 'NASA' },
        GSFC: { n: 'GSFC', p: 'NASA' },
        JSC: { n: 'NASA JSC', p: 'NASA' },
      },
      owners: ['NASA', 'GSFC', 'JSC'],
    });
    const idx = getVocabIndexes()!;
    // "nasa" → NASA + every center in its subtree.
    assert.deepEqual(idx.ownerCodes.get('nasa'), new Set(['NASA', 'GSFC', 'JSC']));
    // A specific center name stays specific.
    assert.deepEqual(idx.ownerCodes.get('gsfc'), new Set(['GSFC']));
  });

  it('agency: a pure provider name resolves to the agency group → tags', () => {
    installQueryVocab(VOCAB);
    const idx = getVocabIndexes()!;
    assert.deepEqual(parseQuery('arianespace').matches.map((m) => [m.group, m.value]), [
      ['agency', 'arianespace'],
    ]);
    assert.deepEqual(idx.agencyTags.get('arianespace'), new Set(['2022-099']));
  });

  it('owner beats agency on a shared name (SpaceX owns what it launches)', () => {
    installQueryVocab(VOCAB);
    // 'spacex' is both an owner (SPX/SPXS) and an agency (SPX) → owner wins.
    assert.equal(ALIAS_TABLE.get('spacex')!.group, 'owner');
  });
});
