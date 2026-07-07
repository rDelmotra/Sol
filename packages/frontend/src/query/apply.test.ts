import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reconcileFilterSlices, type QuerySlices } from './apply';
import { irToFilterPatch, TYPE_KEYS, STATUS_KEYS, SECTOR_KEYS, PURPOSE_KEYS, REGIME_KEYS } from './executor';
import { parseQuery } from './parser';

// The reference-identity contract: groups whose desired state semantically
// equals the current state are ABSENT from the delta (their store references
// survive → no renderer recompute); changed groups are present as NEW objects.

function allOn<K extends string>(keys: readonly K[]): Record<K, boolean> {
  return Object.fromEntries(keys.map((k) => [k, true])) as Record<K, boolean>;
}

function freshAllOnSlices(): QuerySlices {
  return {
    typeFilters: allOn(TYPE_KEYS),
    statusFilters: allOn(STATUS_KEYS),
    sectorFilters: allOn(SECTOR_KEYS),
    purposeFilters: allOn(PURPOSE_KEYS),
    regimeFilters: allOn(REGIME_KEYS),
    countryFilter: { mode: 'all' },
    programFilter: { mode: 'all' },
    launchFilter: { mode: 'all' },
    ownerFilter: { mode: 'all' },
  };
}

describe('reconcileFilterSlices', () => {
  it('unchanged constraint re-emitted → empty delta (references survive)', () => {
    const current = freshAllOnSlices();
    current.countryFilter = { mode: 'only', codes: new Set(['PRC']) };
    // A fresh-but-equal patch, as every debounce tick produces while the user
    // types the next word of "chinese mil…".
    const delta = reconcileFilterSlices(current, {
      countryFilter: { mode: 'only', codes: new Set(['PRC']) },
    });
    assert.deepEqual(delta, {});
  });

  it('residual-only typing (all-on + empty patch) → empty delta, no set()', () => {
    assert.deepEqual(reconcileFilterSlices(freshAllOnSlices(), {}), {});
  });

  it('real change → group present with a NEW object', () => {
    const current = freshAllOnSlices();
    current.countryFilter = { mode: 'only', codes: new Set(['PRC']) };
    const delta = reconcileFilterSlices(current, {
      countryFilter: { mode: 'only', codes: new Set(['PRC', 'CIS']) },
    });
    assert.deepEqual(Object.keys(delta), ['countryFilter']);
    assert.notEqual(delta.countryFilter, current.countryFilter);
    assert.deepEqual(delta.countryFilter, { mode: 'only', codes: new Set(['PRC', 'CIS']) });
  });

  it('narrowing from all-on emits only the narrowed group, as a new record', () => {
    const current = freshAllOnSlices();
    const delta = reconcileFilterSlices(current, irToFilterPatch(parseQuery('military')));
    assert.deepEqual(Object.keys(delta), ['sectorFilters']);
    assert.notEqual(delta.sectorFilters, current.sectorFilters);
    assert.deepEqual(delta.sectorFilters, {
      commercial: false, government: false, military: true, civil: false, unspecified: false,
    });
  });

  it('all-on restore: constrained → empty patch emits fresh all-on / mode:all', () => {
    const current = freshAllOnSlices();
    current.programFilter = { mode: 'only', ids: new Set(['starlink']) };
    current.sectorFilters = {
      commercial: false, government: false, military: true, civil: false, unspecified: false,
    };
    const delta = reconcileFilterSlices(current, {});
    assert.deepEqual(Object.keys(delta).sort(), ['programFilter', 'sectorFilters']);
    assert.deepEqual(delta.programFilter, { mode: 'all' });
    assert.deepEqual(delta.sectorFilters, allOn(SECTOR_KEYS));
  });

  it('all-on restore when already all-on → group absent', () => {
    const current = freshAllOnSlices();
    const delta = reconcileFilterSlices(current, {
      // spread-cloned but value-equal record must be treated as unchanged
      typeFilters: { ...current.typeFilters },
    });
    assert.deepEqual(delta, {});
  });

  // ── G3: launchFilter + ownerFilter reference identity ──────────────────────

  it('G3: new launchFilter emits a fresh set; equal re-emit → empty delta', () => {
    const current = freshAllOnSlices();
    const first = reconcileFilterSlices(current, {
      launchFilter: { mode: 'only', tags: new Set(['2019-074']) },
    });
    assert.deepEqual(Object.keys(first), ['launchFilter']);
    assert.deepEqual(first.launchFilter, { mode: 'only', tags: new Set(['2019-074']) });

    current.launchFilter = { mode: 'only', tags: new Set(['2019-074']) };
    assert.deepEqual(
      reconcileFilterSlices(current, {
        launchFilter: { mode: 'only', tags: new Set(['2019-074']) },
      }),
      {},
    );
  });

  it('G3: ownerFilter change emits only that group as a new object', () => {
    const current = freshAllOnSlices();
    current.ownerFilter = { mode: 'only', codes: new Set(['SPXS']) };
    const delta = reconcileFilterSlices(current, {
      ownerFilter: { mode: 'only', codes: new Set(['SPXS', 'NASA']) },
    });
    assert.deepEqual(Object.keys(delta), ['ownerFilter']);
    assert.notEqual(delta.ownerFilter, current.ownerFilter);
    assert.deepEqual(delta.ownerFilter, { mode: 'only', codes: new Set(['SPXS', 'NASA']) });
  });

  it('G3: constrained launch/owner → empty patch restores fresh mode:all', () => {
    const current = freshAllOnSlices();
    current.launchFilter = { mode: 'only', tags: new Set(['2019-074']) };
    current.ownerFilter = { mode: 'only', codes: new Set(['SPXS']) };
    const delta = reconcileFilterSlices(current, {});
    assert.deepEqual(Object.keys(delta).sort(), ['launchFilter', 'ownerFilter']);
    assert.deepEqual(delta.launchFilter, { mode: 'all' });
    assert.deepEqual(delta.ownerFilter, { mode: 'all' });
  });
});
