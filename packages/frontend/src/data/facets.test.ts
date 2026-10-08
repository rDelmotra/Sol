import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyFacetCounts } from './types';
import { TYPE_KEYS, STATUS_KEYS, SECTOR_KEYS, PURPOSE_KEYS, REGIME_KEYS } from '../query/executor';
import { useStore } from '../store/useStore';

// Pinned literals: the ordered key lists as hand-copied across the codebase before the registry.
const TYPE = ['satellite', 'rocket_body', 'debris', 'unknown', 'deep_space'];
const STATUS = ['in_orbit', 'decayed', 'deorbited', 'beyond_earth', 'exploded', 'unknown'];
const SECTOR = ['commercial', 'government', 'military', 'civil', 'unspecified'];
const PURPOSE = [
  'communications', 'earth_observation', 'navigation', 'technology_dev',
  'space_science', 'space_observation', 'surveillance', 'meteorological', 'other',
];
const REGIME = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];

const on = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));
const zero = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, 0]));

test('key lists equal the pinned ordered literals', () => {
  assert.deepEqual([...TYPE_KEYS], TYPE);
  assert.deepEqual([...STATUS_KEYS], STATUS);
  assert.deepEqual([...SECTOR_KEYS], SECTOR);
  assert.deepEqual([...PURPOSE_KEYS], PURPOSE);
  assert.deepEqual([...REGIME_KEYS], REGIME);
});

test('emptyFacetCounts matches the pinned literal (key order included)', () => {
  const e = emptyFacetCounts();
  assert.deepEqual(Object.keys(e.type), TYPE);
  assert.deepEqual(Object.keys(e.status), STATUS);
  assert.deepEqual(Object.keys(e.sector), SECTOR);
  assert.deepEqual(Object.keys(e.purpose), PURPOSE);
  assert.deepEqual(e, {
    type: zero(TYPE), status: zero(STATUS), sector: zero(SECTOR), purpose: zero(PURPOSE), country: {},
  });
});

test('store initial all-on filters match the pinned literals (key order included)', () => {
  const s = useStore.getState();
  assert.deepEqual(Object.keys(s.typeFilters), TYPE);
  assert.deepEqual(Object.keys(s.statusFilters), STATUS);
  assert.deepEqual(Object.keys(s.sectorFilters), SECTOR);
  assert.deepEqual(Object.keys(s.purposeFilters), PURPOSE);
  assert.deepEqual(s.typeFilters, on(TYPE));
  assert.deepEqual(s.statusFilters, on(STATUS));
  assert.deepEqual(s.sectorFilters, on(SECTOR));
  assert.deepEqual(s.purposeFilters, on(PURPOSE));
});

import * as facets from './facets';

test('registry key lists equal the pinned literals', () => {
  assert.deepEqual([...facets.TYPE_KEYS], TYPE);
  assert.deepEqual([...facets.STATUS_KEYS], STATUS);
  assert.deepEqual([...facets.SECTOR_KEYS], SECTOR);
  assert.deepEqual([...facets.PURPOSE_KEYS], PURPOSE);
  assert.deepEqual([...facets.REGIME_KEYS], REGIME);
});

test('allOn / zeros build ordered fresh records', () => {
  for (const [keys, lit] of [[facets.TYPE_KEYS, TYPE], [facets.STATUS_KEYS, STATUS], [facets.SECTOR_KEYS, SECTOR], [facets.PURPOSE_KEYS, PURPOSE]] as const) {
    const a = facets.allOn(keys as readonly string[]);
    assert.deepEqual(Object.keys(a), lit);
    assert.deepEqual(a, on(lit));
    assert.deepEqual(facets.zeros(keys as readonly string[]), zero(lit));
  }
  assert.notEqual(facets.allOn(facets.TYPE_KEYS), facets.allOn(facets.TYPE_KEYS));
});
