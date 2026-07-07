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

function org(
  code: string,
  name: string,
  opts: { aliases?: string[]; parent?: string } = {},
): OrgRecord {
  return {
    code,
    name,
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    stateCode: null,
    cls: 'B',
    sectors: ['commercial'],
    type: 'O',
    parent: opts.parent ?? null,
    lat: null,
    lon: null,
    tstart: null,
    tstop: null,
  };
}

function launch(
  tag: string,
  lvFamily: string | null,
  siteName: string | null,
  agencies: string[] = [],
): LaunchRecord {
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
    agencies,
    code: 'OS',
    success: true,
    category: null,
    group: null,
    orbPay: null,
  };
}

test('buildQueryVocab: launches tuple carries [lvFamily, siteName, agencies]', () => {
  const vocab = buildQueryVocab([], new Map(), {
    '2019-074': launch('2019-074', 'Falcon9', 'Cape Canaveral', ['SPX']),
    '2026-F05': launch('2026-F05', null, null, []),
  });
  assert.deepEqual(vocab.launches['2019-074'], ['Falcon9', 'Cape Canaveral', ['SPX']]);
  assert.deepEqual(vocab.launches['2026-F05'], [null, null, []]);
});

test('buildQueryVocab: emits in-orbit owners; decayed-only + unknown codes skipped', () => {
  const orgs = new Map<string, OrgRecord>([
    ['SPXS', org('SPXS', 'SpaceX', { aliases: ['Space Exploration Technologies'] })],
    ['OLDCO', org('OLDCO', 'Defunct Co')],
  ]);
  const records = [
    record({ noradId: 1, orbitalStatus: 'in_orbit', gcat: { owner: 'SPXS' } }),
    record({ noradId: 2, orbitalStatus: 'decayed', gcat: { owner: 'OLDCO' } }),
    record({ noradId: 3, orbitalStatus: 'in_orbit', gcat: { owner: 'GHOST' } }),
    record({ noradId: 4, orbitalStatus: 'in_orbit', gcat: { owner: 'SPXS/NASA?' } }),
  ];
  const vocab = buildQueryVocab(records, orgs, {});
  assert.deepEqual(Object.keys(vocab.orgs), ['SPXS']);
  assert.equal(vocab.orgs.SPXS.n, 'SpaceX');
  assert.deepEqual(vocab.orgs.SPXS.a, ['Space Exploration Technologies']);
  assert.equal('p' in vocab.orgs.SPXS, false); // no parent
  assert.deepEqual(vocab.owners, ['SPXS']); // the only in-orbit owner
});

test('buildQueryVocab: ships parent + pulls in ancestor orgs (family tree)', () => {
  const orgs = new Map<string, OrgRecord>([
    ['GSFC', org('GSFC', 'GSFC', { parent: 'NASA' })],
    ['NASA', org('NASA', 'NASA')],
    ['KUIP', org('KUIP', 'Kuiper Systems', { parent: 'AMAZ' })],
    ['AMAZ', org('AMAZ', 'Amazon')], // owns nothing — included as an ancestor
  ]);
  const records = [
    record({ noradId: 1, orbitalStatus: 'in_orbit', gcat: { owner: 'GSFC' } }),
    record({ noradId: 2, orbitalStatus: 'in_orbit', gcat: { owner: 'KUIP' } }),
  ];
  const vocab = buildQueryVocab(records, orgs, {});
  assert.equal(vocab.orgs.GSFC.p, 'NASA');
  assert.ok(vocab.orgs.NASA, 'NASA ancestor emitted though it owns nothing');
  assert.equal(vocab.orgs.KUIP.p, 'AMAZ');
  assert.ok(vocab.orgs.AMAZ, 'Amazon ancestor emitted for parent-brand search');
});

test('buildQueryVocab: launch-agency orgs are emitted even when they own nothing', () => {
  const orgs = new Map<string, OrgRecord>([
    ['SPXS', org('SPXS', 'SpaceX')],
    ['ARIA', org('ARIA', 'Arianespace')], // pure provider — owns 0 in-orbit
  ]);
  const records = [record({ orbitalStatus: 'in_orbit', gcat: { owner: 'SPXS' } })];
  const vocab = buildQueryVocab(records, orgs, {
    '2020-001': launch('2020-001', 'Ariane5', 'Kourou', ['ARIA']),
  });
  assert.ok(vocab.orgs.ARIA, 'agency org emitted for the agency facet');
  assert.deepEqual(vocab.launches['2020-001'][2], ['ARIA']);
});

test('buildQueryVocab: alias/parent keys omitted when absent', () => {
  const orgs = new Map<string, OrgRecord>([['NASA', org('NASA', 'NASA')]]);
  const vocab = buildQueryVocab(
    [record({ orbitalStatus: 'in_orbit', gcat: { owner: 'NASA' } })],
    orgs,
    {},
  );
  assert.equal(vocab.orgs.NASA.n, 'NASA');
  assert.equal('a' in vocab.orgs.NASA, false);
  assert.equal('p' in vocab.orgs.NASA, false);
});
