import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { parseQuery } from './parser';
import { irToFilterPatch } from './executor';
import { installQueryVocab, resetQueryVocabForTests } from './vocab';
import { resetAliasTableForTests } from './aliases';
import type { QueryVocab } from '../data/query-vocab-client';

describe('irToFilterPatch', () => {
  it('emits only constrained groups', () => {
    const patch = irToFilterPatch(parseQuery('chinese military'));
    assert.deepEqual(Object.keys(patch).sort(), ['countryFilter', 'sectorFilters']);
    assert.deepEqual(patch.sectorFilters, {
      commercial: false,
      government: false,
      military: true,
      civil: false,
      unspecified: false,
    });
    assert.deepEqual(patch.countryFilter, { mode: 'only', codes: new Set(['PRC']) });
  });

  it('compiles a program constraint', () => {
    const patch = irToFilterPatch(parseQuery('starlink'));
    assert.deepEqual(Object.keys(patch), ['programFilter']);
    assert.deepEqual(patch.programFilter, { mode: 'only', ids: new Set(['starlink']) });
  });

  it('unions multiple values in one group', () => {
    const patch = irToFilterPatch(parseQuery('chinese russian'));
    assert.deepEqual(patch.countryFilter, { mode: 'only', codes: new Set(['PRC', 'CIS']) });
  });

  it('narrows regime + type together', () => {
    const patch = irToFilterPatch(parseQuery('debris in leo'));
    assert.deepEqual(patch.regimeFilters, {
      LEO: true, MEO: false, GEO: false, HEO: false, OTHER: false,
    });
    assert.deepEqual(patch.typeFilters, {
      satellite: false, rocket_body: false, debris: true, unknown: false, deep_space: false,
    });
  });

  it('empty IR → empty patch', () => {
    assert.deepEqual(irToFilterPatch(parseQuery('')), {});
    assert.deepEqual(irToFilterPatch(parseQuery('zarya')), {});
  });
});

// ── G3: launch-graph compilation (union within group, intersect across) ───────

const VOCAB: QueryVocab = {
  launches: {
    '2021-005': ['Falcon9', 'Vandenberg'],   // Falcon9 ∧ Vandenberg ∧ 2021
    '2021-010': ['Falcon9', 'Canaveral'],    // Falcon9 ∧ 2021
    '2020-005': ['Atlas5', 'Vandenberg'],    // Vandenberg (2020)
    '2020-001': ['Soyuz', 'Baykonur'],       // Baykonur
  },
  orgs: {
    SPXS: { n: 'SpaceX' },
    RSC: { n: 'Roscosmos' },
  },
};

describe('irToFilterPatch — G3 launch/owner facets', () => {
  afterEach(() => {
    resetQueryVocabForTests();
    resetAliasTableForTests();
  });

  it('unions launch tags across two vehicles in the same group', () => {
    installQueryVocab(VOCAB);
    const patch = irToFilterPatch(parseQuery('falcon 9 atlas 5'));
    assert.deepEqual(patch.launchFilter, {
      mode: 'only',
      tags: new Set(['2021-005', '2021-010', '2020-005']),
    });
  });

  it('intersects across subgroups (vehicle ∩ site ∩ year)', () => {
    installQueryVocab(VOCAB);
    const patch = irToFilterPatch(parseQuery('falcon 9 from vandenberg 2021'));
    assert.deepEqual(patch.launchFilter, { mode: 'only', tags: new Set(['2021-005']) });
  });

  it('a bare launch tag filters directly, no vocab needed', () => {
    resetQueryVocabForTests();
    const patch = irToFilterPatch(parseQuery('2019-074'));
    assert.deepEqual(patch.launchFilter, { mode: 'only', tags: new Set(['2019-074']) });
  });

  it('unions owner codes', () => {
    installQueryVocab(VOCAB);
    const patch = irToFilterPatch(parseQuery('spacex roscosmos'));
    assert.deepEqual(patch.ownerFilter, { mode: 'only', codes: new Set(['SPXS', 'RSC']) });
  });

  it('empty intersection yields a present-but-empty tag set (0 objects)', () => {
    installQueryVocab(VOCAB);
    const patch = irToFilterPatch(parseQuery('falcon 9 from baikonur'));
    assert.deepEqual(patch.launchFilter, { mode: 'only', tags: new Set() });
  });

  it('without vocab a vehicle word rides to residual — no launchFilter', () => {
    resetQueryVocabForTests();
    resetAliasTableForTests();
    const ir = parseQuery('falcon 9');
    const patch = irToFilterPatch(ir);
    assert.equal(patch.launchFilter, undefined);
    assert.match(ir.text, /falcon/i);
  });
});
