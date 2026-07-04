import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveInlineFacets } from '../../src/enrichment/store.js';
import type { ObjectMetadata } from '../../src/enrichment/types.js';

// Pure precedence tests for the runtime facet derivation — no disk, no module
// cache. UCS/satcat values must always survive; program defaults fill only
// empty facets; the payload gate lives here (the matcher itself is gate-free).

function record(overrides: Partial<ObjectMetadata>): ObjectMetadata {
  return {
    noradId: 1,
    operatorCountry: null,
    operatorOrg: null,
    sectors: [],
    purpose: 'other',
    detailedPurpose: null,
    operationalStatus: 'unknown',
    orbitalStatus: 'unknown',
    objectType: 'unknown',
    contractor: null,
    contractorCountry: null,
    launchSite: null,
    launchVehicle: null,
    launchMassKg: null,
    dryMassKg: null,
    powerW: null,
    expectedLifetimeYrs: null,
    cospar: null,
    orbitClass: null,
    sources: [],
    ...overrides,
  };
}

describe('deriveInlineFacets', () => {
  it('UCS wins: record facets survive a program match, program still stamped', () => {
    // Simulates a build-time-stamped record where UCS said 'government' but the
    // artifact was built WITHOUT the program pass reaching it (program absent).
    const m = record({ sectors: ['government'], purpose: 'space_science', operatorCountry: 'US' });
    const f = deriveInlineFacets(m, 'STARLINK-32001', true);
    assert.deepEqual(f.sectors, ['government']);
    assert.equal(f.purpose, 'space_science');
    assert.equal(f.operatorCountry, 'US');
    assert.equal(f.program, 'starlink'); // live match stamps membership
  });

  it('no record + payload → full program defaults, status stays unknown', () => {
    const f = deriveInlineFacets(undefined, 'STARLINK-32001', true);
    assert.equal(f.program, 'starlink');
    assert.deepEqual(f.sectors, ['commercial']);
    assert.equal(f.purpose, 'communications');
    assert.equal(f.operatorCountry, 'US');
    assert.equal(f.status, 'unknown');
  });

  it('non-payload objects never live-match (debris gate)', () => {
    const f = deriveInlineFacets(undefined, 'FENGYUN 1C DEB', false);
    assert.equal(f.program, undefined);
    assert.deepEqual(f.sectors, []);
    assert.equal(f.purpose, 'other');
  });

  it('missing payload flag defaults to no match (backward-compatible 1-arg path)', () => {
    const f = deriveInlineFacets(undefined, 'STARLINK-32001');
    assert.equal(f.program, undefined);
  });

  it('membership-only program (cosmos): program set, facets stay empty', () => {
    const f = deriveInlineFacets(undefined, 'COSMOS 2569', true);
    assert.equal(f.program, 'cosmos');
    assert.deepEqual(f.sectors, []);
    assert.equal(f.purpose, 'other');
    assert.equal(f.operatorCountry, null);
  });

  it('artifact program beats live match (GLONASS vs live COSMOS name)', () => {
    const m = record({
      program: 'glonass',
      sectors: ['military', 'government'],
      purpose: 'navigation',
      operatorCountry: 'CIS',
    });
    const f = deriveInlineFacets(m, 'COSMOS 2569', true);
    assert.equal(f.program, 'glonass');
    assert.equal(f.purpose, 'navigation');
  });

  it('does not mutate the cached record', () => {
    const m = record({});
    deriveInlineFacets(m, 'STARLINK-32001', true);
    assert.deepEqual(m.sectors, []);
    assert.equal(m.purpose, 'other');
    assert.equal(m.program, undefined);
  });
});
