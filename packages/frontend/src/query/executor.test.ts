import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseQuery } from './parser';
import { irToFilterPatch } from './executor';

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
