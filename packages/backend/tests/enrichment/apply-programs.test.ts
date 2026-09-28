import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyProgramDefaults, matchProgram, PROGRAMS } from '../../src/enrichment/programs.js';
import type { ObjectMetadata } from '@orbitwatch/contracts';

// Build-time provenance semantics: 'inferred' appended to sources exactly once;
// facetProvenance keys exist only for facets the program actually filled;
// facetProvenance is never an empty {} (slim() would keep it).

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
    objectType: 'payload',
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
    sources: ['gcat'],
    ...overrides,
  };
}

const starlink = PROGRAMS.find((p) => p.id === 'starlink')!;
const cosmos = PROGRAMS.find((p) => p.id === 'cosmos')!;

describe('applyProgramDefaults', () => {
  it('fills empty facets, tags per-facet provenance, appends inferred once', () => {
    const rec = record({});
    applyProgramDefaults(rec, starlink);
    assert.equal(rec.program, 'starlink');
    assert.deepEqual(rec.sectors, ['commercial']);
    assert.equal(rec.purpose, 'communications');
    assert.equal(rec.facetProvenance?.sectors, 'inferred');
    assert.equal(rec.facetProvenance?.purpose, 'inferred');
    assert.deepEqual(rec.sources, ['gcat', 'inferred']);

    // Idempotent on sources — a second apply must not duplicate 'inferred'.
    applyProgramDefaults(rec, starlink);
    assert.deepEqual(rec.sources, ['gcat', 'inferred']);
  });

  it('UCS-covered facets get no provenance keys and keep their values', () => {
    const rec = record({
      sectors: ['government'],
      purpose: 'space_science',
      operatorCountry: 'US',
      operatorOrg: 'NASA',
      sources: ['gcat', 'ucs-2023-05'],
    });
    applyProgramDefaults(rec, starlink);
    assert.equal(rec.program, 'starlink');            // membership always stamped
    assert.deepEqual(rec.sectors, ['government']);    // UCS wins
    assert.equal(rec.purpose, 'space_science');
    assert.equal(rec.operatorCountry, 'US');
    assert.equal(rec.operatorOrg, 'NASA');
    assert.equal(rec.facetProvenance, undefined);     // nothing inferred → no keys, never {}
    assert.ok(rec.sources.includes('inferred'));      // membership itself is inference
  });

  it('membership-only entry (cosmos) stamps program but fills nothing', () => {
    const rec = record({});
    applyProgramDefaults(rec, cosmos);
    assert.equal(rec.program, 'cosmos');
    assert.deepEqual(rec.sectors, []);
    assert.equal(rec.purpose, 'other');
    assert.equal(rec.facetProvenance, undefined);
  });

  it('does not copy the entry sectors array by reference', () => {
    const rec = record({});
    applyProgramDefaults(rec, starlink);
    rec.sectors.push('civil');
    assert.deepEqual(starlink.sectors, ['commercial']);
  });
});

describe('build-pass integration shape', () => {
  it('the canonical pass (match by name, payloads only) works end-to-end', () => {
    const rec = record({});
    const entry = matchProgram('Starlink-1008');
    assert.ok(entry);
    applyProgramDefaults(rec, entry);
    assert.equal(rec.program, 'starlink');
  });
});
