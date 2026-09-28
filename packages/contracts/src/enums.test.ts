// ============================================================
// Pins the domain arrays: exact membership AND exact order. These arrays are
// now the source of truth for packages/analytic/src/schema.ts's `*_DOMAIN`
// exports (C1) — an accidental reorder here silently changes the compiler
// prompt fingerprint and the validator's accepted enum literals, so pin hard.
// ============================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANALYTIC_OBJECT_TYPES,
  OBJECT_CATEGORIES,
  ORBITAL_REGIMES,
  ORBITAL_STATUSES,
  OPERATIONAL_STATUSES,
  SECTORS,
  PURPOSES,
  OBJECT_TYPES,
  METADATA_SOURCES,
} from './enums.js';

describe('ANALYTIC_OBJECT_TYPES (analytic IR objectType domain)', () => {
  it('matches schema.ts OBJECT_TYPE_DOMAIN exactly', () => {
    assert.deepEqual(ANALYTIC_OBJECT_TYPES, ['payload', 'rocket_body', 'debris', 'component', 'unknown']);
  });
});

describe('OBJECT_CATEGORIES (category domain)', () => {
  it('matches schema.ts CATEGORY_DOMAIN exactly', () => {
    assert.deepEqual(OBJECT_CATEGORIES, [
      'active_satellite',
      'inactive_satellite',
      'rocket_body',
      'debris',
      'unknown',
      'deep_space',
    ]);
  });
});

describe('ORBITAL_REGIMES (regime domain)', () => {
  it('matches schema.ts REGIME_DOMAIN exactly', () => {
    assert.deepEqual(ORBITAL_REGIMES, ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']);
  });
});

describe('ORBITAL_STATUSES (status domain)', () => {
  it('matches schema.ts ORBITAL_STATUS_DOMAIN exactly', () => {
    assert.deepEqual(ORBITAL_STATUSES, ['in_orbit', 'decayed', 'deorbited', 'beyond_earth', 'exploded', 'unknown']);
  });
});

describe('OPERATIONAL_STATUSES (operationalStatus domain)', () => {
  it('matches schema.ts OPERATIONAL_STATUS_DOMAIN exactly', () => {
    assert.deepEqual(OPERATIONAL_STATUSES, [
      'operational',
      'partial',
      'nonoperational',
      'backup',
      'spare',
      'extended',
      'unknown',
    ]);
  });
});

describe('SECTORS (sectors domain)', () => {
  it('matches schema.ts SECTOR_DOMAIN exactly', () => {
    assert.deepEqual(SECTORS, ['commercial', 'government', 'military', 'civil']);
  });
});

describe('PURPOSES (purpose domain)', () => {
  it('matches schema.ts PURPOSE_DOMAIN exactly', () => {
    assert.deepEqual(PURPOSES, [
      'communications',
      'earth_observation',
      'navigation',
      'technology_dev',
      'space_science',
      'space_observation',
      'surveillance',
      'meteorological',
      'other',
    ]);
  });
});

describe('OBJECT_TYPES (live-catalog wire objectType domain)', () => {
  it('matches backend/frontend ObjectType exactly, and differs from ANALYTIC_OBJECT_TYPES by design', () => {
    assert.deepEqual(OBJECT_TYPES, ['satellite', 'rocket_body', 'debris', 'unknown']);
    // The wire spelling ('satellite', no 'component') is deliberately not the
    // analytic IR spelling ('payload', has 'component') — guard against the
    // two ever being silently merged.
    assert.notDeepEqual([...OBJECT_TYPES], [...ANALYTIC_OBJECT_TYPES]);
  });
});

describe('METADATA_SOURCES (ObjectMetadata provenance domain)', () => {
  it('matches backend/frontend MetadataSource exactly', () => {
    assert.deepEqual(METADATA_SOURCES, ['ucs-2023-05', 'gcat', 'gcat-org', 'spacetrack', 'inferred', 'inherited']);
  });
});
