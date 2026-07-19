// P3 S2 Parts A+B — catalog.ts provider tests.
// Spec: my_plans/marvin/p3/S2_catalog_provider_universe_all.md "Tests" #1-4.
// (#5-7 depend on Part C registry composition — land with that step.)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCatalogProvider, createAllSpineProvider } from '../../src/analytic/providers/catalog.js';
import type { EnrichedTLEObject, VersionInfo } from '../../src/types/index.js';
import type { DecayedCatalogRow } from '../../src/enrichment/types.js';

// omm is cast loosely — the fixture only needs the OMM numeric keys the provider reads.
function omm(fields: Record<string, unknown>) {
  return { OBJECT_NAME: 'x', OBJECT_ID: '', ...fields } as unknown as EnrichedTLEObject['omm'];
}

const FIXTURE_CATALOG: EnrichedTLEObject[] = [
  {
    noradId: 1, name: 'Alpha', objectType: 'satellite', category: 'active_satellite',
    regime: 'LEO', countryCode: 'US', launchDate: '2020-05-15',
    period: 95, apogee: 500, perigee: 480, inclination: 51.6, rcsSize: 'LARGE',
    epoch: '2024-01-01T00:00:00Z', sectors: ['commercial'], purpose: 'communications',
    status: 'in_orbit', program: 'starlink', launchTag: '2020-030', owner: 'SPX',
    omm: omm({ OBJECT_ID: '2020-030A', MEAN_MOTION: 15.5 }),
  },
  {
    // No launchDate; a non-numeric OMM field to exercise the ommNum finite-guard.
    noradId: 2, name: 'Beta', objectType: 'rocket_body', category: 'rocket_body',
    regime: 'LEO', countryCode: 'CIS', launchDate: null,
    period: 90, apogee: 400, perigee: 390, inclination: 65, rcsSize: null,
    epoch: '2024-01-01T00:00:00Z', sectors: [], purpose: 'other', status: 'in_orbit',
    omm: omm({ MEAN_MOTION: 'not-a-number' }),
  },
];

function makeVersion(v: string): VersionInfo {
  return { version: v, count: FIXTURE_CATALOG.length, byteSize: 1 };
}

// ── Test 1 — field parity spot-checks ────────────────────────────────────────
describe('createCatalogProvider — field parity', () => {
  const provider = createCatalogProvider({
    readCatalog: () => FIXTURE_CATALOG,
    readVersion: () => makeVersion('v1'),
  });

  it("objectType maps 'satellite' -> 'payload' (client parity); passes through other types", () => {
    assert.equal(provider.getField(1, 'objectType', 0), 'payload');
    assert.equal(provider.getField(2, 'objectType', 0), 'rocket_body');
  });

  it('ommNum finite-guard returns null for a non-numeric OMM field', () => {
    assert.equal(provider.getField(2, 'meanMotion', 0), null);
  });

  it('ommNum returns the number for a valid OMM field', () => {
    assert.equal(provider.getField(1, 'meanMotion', 0), 15.5);
  });

  it('semiMajorAxisKm matches the hand-computed formula (µ=398600.4418)', () => {
    const n = 15.5;
    const radPerSec = (n * 2 * Math.PI) / 86400;
    const expected = Math.cbrt(398600.4418 / (radPerSec * radPerSec));
    assert.equal(provider.getField(1, 'semiMajorAxisKm', 0), expected);
  });

  it('ageYears uses tMs, not the current wall clock', () => {
    const t = Date.parse('2024-01-01T00:00:00Z'); // exactly epoch listed above
    const expected = (t - Date.parse('2020-05-15')) / (365.25 * 86400_000);
    assert.equal(provider.getField(1, 'ageYears', t), expected);
    // A different tMs must produce a different answer — proves tMs is actually used.
    const later = t + 365.25 * 86400_000;
    assert.ok((provider.getField(1, 'ageYears', later) as number) > expected);
  });

  it('launchYear null-guards a missing launchDate', () => {
    assert.equal(provider.getField(2, 'launchYear', 0), null);
  });

  it('miss (unknown norad) returns null, not throw', () => {
    assert.equal(provider.getField(999, 'name', 0), null);
  });

  it('inline facets (sectors/purpose/status/program/launchTag/owner) pass through', () => {
    assert.deepEqual(provider.getField(1, 'sectors', 0), ['commercial']);
    assert.equal(provider.getField(1, 'program', 0), 'starlink');
    assert.equal(provider.getField(1, 'launchTag', 0), '2020-030');
    assert.equal(provider.getField(1, 'owner', 0), 'SPX');
    assert.equal(provider.getField(2, 'program', 0), null); // absent on the fixture
  });
});

// ── Test 2 — version-change reload / stable-version no-reload ───────────────
describe('createCatalogProvider — version-change reload', () => {
  it('stable version within the throttle window: no re-read', () => {
    let readCatalogCalls = 0;
    let readVersionCalls = 0;
    const provider = createCatalogProvider({
      readCatalog: () => { readCatalogCalls++; return FIXTURE_CATALOG; },
      readVersion: () => { readVersionCalls++; return makeVersion('v1'); },
    });
    provider.spine();
    provider.spine();
    provider.getField(1, 'name', 0);
    assert.equal(readCatalogCalls, 1, 'catalog should load once');
    assert.equal(readVersionCalls, 1, 'version check is throttled — one read for a burst of calls');
  });

  it('version change after the throttle window triggers a reload', async () => {
    let version = 'v1';
    let readCatalogCalls = 0;
    const provider = createCatalogProvider({
      readCatalog: () => { readCatalogCalls++; return FIXTURE_CATALOG; },
      readVersion: () => makeVersion(version),
    });
    provider.spine();
    assert.equal(readCatalogCalls, 1);

    version = 'v2';
    // Wait past the 1s version-check throttle window.
    await new Promise((r) => setTimeout(r, 1100));
    provider.spine();
    assert.equal(readCatalogCalls, 2, 'a version change past the throttle window must reload');
  });
});

// ── Test 3 — all-spine union ──────────────────────────────────────────────────
describe('createAllSpineProvider — spine union', () => {
  it('spine is the sorted-ascending dedup union of catalog ids and enrichment keys', () => {
    // Catalog has 1,2. Enrichment has 2,3 (3 is enrichment-only — a decayed object
    // absent from the live catalog; 1 overlaps).
    const enrichmentMap = new Map<number, unknown>([[2, {}], [3, {}]]);
    const provider = createAllSpineProvider({
      readCatalog: () => FIXTURE_CATALOG,
      readVersion: () => makeVersion('v1'),
      enrichment: () => enrichmentMap,
      decayed: () => [],
    });
    assert.deepEqual(provider.spine(), [1, 2, 3]);
  });

  it('identity fallback fields come from getDecayedCatalog rows', () => {
    const enrichmentMap = new Map<number, unknown>([[1, {}], [3, {}]]);
    const decayedRows: DecayedCatalogRow[] = [
      { noradId: 3, name: 'DeadSat', country: 'FR', status: 'decayed', objectType: 'payload', orbitClass: null, launchYear: 1999 },
    ];
    const provider = createAllSpineProvider({
      readCatalog: () => FIXTURE_CATALOG,
      readVersion: () => makeVersion('v1'),
      enrichment: () => enrichmentMap,
      decayed: () => decayedRows,
    });

    assert.equal(provider.getField(3, 'noradId', 0), 3); // spine identity, never null
    assert.equal(provider.getField(3, 'name', 0), 'DeadSat');
    assert.equal(provider.getField(3, 'countryCode', 0), 'FR');
    assert.equal(provider.getField(3, 'launchYear', 0), 1999);
  });

  it('claims only the four identity-fallback fields — no decayed row -> null, not throw', () => {
    const provider = createAllSpineProvider({
      readCatalog: () => FIXTURE_CATALOG,
      readVersion: () => makeVersion('v1'),
      enrichment: () => new Map(),
      decayed: () => [],
    });
    assert.equal(provider.getField(1, 'name', 0), null);
    assert.equal(provider.getField(1, 'countryCode', 0), null);
    assert.equal(provider.getField(1, 'launchYear', 0), null);
    // Fields it does NOT claim (e.g. apogeeKm) are simply outside its `fields` list —
    // the registry chain, not this provider, is responsible for routing those away.
    assert.equal(provider.getField(1, 'apogeeKm', 0), null);
  });

  it('fields list is exactly the four identity-fallback fields', () => {
    const provider = createAllSpineProvider();
    assert.deepEqual([...provider.fields].sort(), ['countryCode', 'launchYear', 'name', 'noradId']);
  });
});

// ── Test 4 — chain integration (manual composition, Part C lands the registry) ─
describe('catalog + all-spine chain — manual composition sanity', () => {
  it('a dead object resolves name from all-spine, apogeeKm stays null (no orbital-element store)', () => {
    const enrichmentMap = new Map<number, unknown>([[1, {}], [3, {}]]);
    const decayedRows: DecayedCatalogRow[] = [
      { noradId: 3, name: 'DeadSat', country: 'FR', status: 'decayed', objectType: 'payload', orbitClass: null, launchYear: 1999 },
    ];
    const catalog = createCatalogProvider({ readCatalog: () => FIXTURE_CATALOG, readVersion: () => makeVersion('v1') });
    const allSpine = createAllSpineProvider({
      readCatalog: () => FIXTURE_CATALOG, readVersion: () => makeVersion('v1'),
      enrichment: () => enrichmentMap, decayed: () => decayedRows,
    });

    // Chain order: catalog first, all-spine second (per spec Part C rationale).
    const chainField = (noradId: number, field: string) =>
      catalog.getField(noradId, field, 0) ?? allSpine.getField(noradId, field, 0);

    assert.equal(chainField(3, 'name'), 'DeadSat'); // catalog miss -> all-spine fills it
    assert.equal(chainField(3, 'apogeeKm'), null);  // neither provider claims it for dead objects
    assert.equal(chainField(1, 'name'), 'Alpha');   // live object resolves from catalog first
  });
});
