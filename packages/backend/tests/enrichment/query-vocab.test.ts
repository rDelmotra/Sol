// Tests for the G3 query-vocab artifact builder (pure, fixture-driven).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryVocab } from '../../src/enrichment/query-vocab.js';
import type { ObjectMetadata } from '../../src/enrichment/types.js';
import type { OrgRecord } from '../../src/enrichment/gcat/orgs.js';
import type { LaunchRecord } from '../../src/enrichment/gcat/launches.js';

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

function org(code: string, name: string, aliases?: string[]): OrgRecord {
  return {
    code,
    name,
    ...(aliases ? { aliases } : {}),
    stateCode: null,
    cls: 'B',
    sectors: ['commercial'],
    type: 'O',
    parent: null,
    lat: null,
    lon: null,
    tstart: null,
    tstop: null,
  };
}

function launch(tag: string, lvFamily: string | null, siteName: string | null): LaunchRecord {
  return {
    tag,
    date: '2019 Nov 11',
    lvType: lvFamily ?? 'UNK',
    lvFamily,
    variant: null,
    flightId: null,
    mission: null,
    site: null,
    siteName,
    pad: null,
    platform: null,
    agencies: [],
    code: 'OS',
    success: true,
    category: null,
    group: null,
    orbPay: null,
  };
}

test('buildQueryVocab: launches tuple carries [lvFamily, siteName] incl. nulls', () => {
  const vocab = buildQueryVocab([], new Map(), {
    '2019-074': launch('2019-074', 'Falcon9', 'Cape Canaveral'),
    '2026-F05': launch('2026-F05', null, null),
  });
  assert.deepEqual(vocab.launches['2019-074'], ['Falcon9', 'Cape Canaveral']);
  assert.deepEqual(vocab.launches['2026-F05'], [null, null]);
});

test('buildQueryVocab: orgs restricted to in-orbit owners; unknown codes skipped', () => {
  const orgs = new Map<string, OrgRecord>([
    ['SPXS', org('SPXS', 'SpaceX', ['Space Exploration Technologies'])],
    ['OLDCO', org('OLDCO', 'Defunct Co')],
  ]);
  const records = [
    record({ noradId: 1, orbitalStatus: 'in_orbit', gcat: { owner: 'SPXS' } }),
    // Decayed-only owner → excluded from the vocab.
    record({ noradId: 2, orbitalStatus: 'decayed', gcat: { owner: 'OLDCO' } }),
    // In-orbit but the code has no org row → skipped.
    record({ noradId: 3, orbitalStatus: 'in_orbit', gcat: { owner: 'GHOST' } }),
    // Multi-valued owner with '?' — primary code wins.
    record({ noradId: 4, orbitalStatus: 'in_orbit', gcat: { owner: 'SPXS/NASA?' } }),
  ];
  const vocab = buildQueryVocab(records, orgs, {});
  assert.deepEqual(Object.keys(vocab.orgs), ['SPXS']);
  assert.equal(vocab.orgs.SPXS.n, 'SpaceX');
  assert.deepEqual(vocab.orgs.SPXS.a, ['Space Exploration Technologies']);
});

test('buildQueryVocab: alias key omitted when the org has no variants', () => {
  const orgs = new Map<string, OrgRecord>([['NASA', org('NASA', 'NASA')]]);
  const vocab = buildQueryVocab(
    [record({ orbitalStatus: 'in_orbit', gcat: { owner: 'NASA' } })],
    orgs,
    {},
  );
  assert.equal(vocab.orgs.NASA.n, 'NASA');
  assert.equal('a' in vocab.orgs.NASA, false);
});
