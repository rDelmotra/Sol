import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OMMJsonObject } from 'satellite.js';
import { buildCatalogResult } from './tle-client';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';

function makeTestOmm(noradId: number): OMMJsonObject {
  return {
    OBJECT_NAME: `OBJ-${noradId}`,
    OBJECT_ID: '2000-001A',
    EPOCH: '2026-06-19T00:00:00.000000Z',
    MEAN_MOTION: 15.5,
    ECCENTRICITY: 0.0001,
    INCLINATION: 51.6,
    RA_OF_ASC_NODE: 0,
    ARG_OF_PERICENTER: 0,
    MEAN_ANOMALY: 0,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: noradId,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 0,
    BSTAR: 0,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0,
  };
}

function obj(
  noradId: number,
  category: EnrichedTLEObject['category'],
  regime: EnrichedTLEObject['regime'],
): EnrichedTLEObject {
  return {
    noradId,
    name: `OBJ-${noradId}`,
    omm: makeTestOmm(noradId),
    objectType: 'satellite',
    category,
    regime,
    countryCode: 'US',
    launchDate: null,
    period: 90,
    apogee: 400,
    perigee: 400,
    inclination: 51,
    rcsSize: null,
    epoch: '2026-06-19T00:00:00.000Z',
    sectors: [],
    purpose: 'other',
    status: 'in_orbit',
  };
}

describe('buildCatalogResult', () => {
  it('maps catalog to TLE inputs and tallies category/regime counts', () => {
    const catalogData = [
      obj(1, 'active_satellite', 'LEO'),
      obj(2, 'active_satellite', 'LEO'),
      obj(3, 'debris', 'GEO'),
    ];

    const result = buildCatalogResult(catalogData);

    assert.equal(result.catalogData, catalogData);
    assert.deepEqual(result.tles, [
      { noradId: 1, omm: makeTestOmm(1) },
      { noradId: 2, omm: makeTestOmm(2) },
      { noradId: 3, omm: makeTestOmm(3) },
    ]);
    assert.equal(result.categoryCounts.active_satellite, 2);
    assert.equal(result.categoryCounts.debris, 1);
    assert.equal(result.categoryCounts.rocket_body, 0);
    assert.equal(result.regimeCounts.LEO, 2);
    assert.equal(result.regimeCounts.GEO, 1);
    assert.equal(result.regimeCounts.MEO, 0);

    // Phase B facet totals (all three objects share type/status/country/purpose;
    // no UCS sectors → 'unspecified').
    assert.equal(result.facetCounts.type.satellite, 3);
    assert.equal(result.facetCounts.status.in_orbit, 3);
    assert.equal(result.facetCounts.sector.unspecified, 3);
    assert.equal(result.facetCounts.purpose.other, 3);
    assert.equal(result.facetCounts.country.US, 3);
  });

  it('returns zeroed counts for an empty catalog', () => {
    const result = buildCatalogResult([]);
    assert.deepEqual(result.tles, []);
    assert.equal(result.categoryCounts.active_satellite, 0);
    assert.equal(result.regimeCounts.LEO, 0);
    assert.equal(result.facetCounts.type.satellite, 0);
    assert.deepEqual(result.facetCounts.country, {});
  });

  it('tallies multi-sector membership and an unspecified bucket', () => {
    const a = obj(10, 'active_satellite', 'LEO');
    a.sectors = ['military', 'government'];
    a.purpose = 'communications';
    a.status = 'decayed';
    a.countryCode = 'PRC';
    const b = obj(11, 'active_satellite', 'LEO'); // sectors [] → unspecified

    const { facetCounts } = buildCatalogResult([a, b]);
    assert.equal(facetCounts.sector.military, 1);
    assert.equal(facetCounts.sector.government, 1);
    assert.equal(facetCounts.sector.unspecified, 1);
    assert.equal(facetCounts.status.decayed, 1);
    assert.equal(facetCounts.status.in_orbit, 1);
    assert.equal(facetCounts.purpose.communications, 1);
    assert.equal(facetCounts.country.PRC, 1);
    assert.equal(facetCounts.country.US, 1);
  });

  // ── G3: launchTag COSPAR fallback stamp ────────────────────────────────────

  it('stamps launchTag from OBJECT_ID when the backend did not inline it', () => {
    const a = obj(20, 'active_satellite', 'LEO'); // OBJECT_ID '2000-001A'
    assert.equal(a.launchTag, undefined);
    buildCatalogResult([a]);
    assert.equal(a.launchTag, '2000-001'); // trailing piece letter stripped
  });

  it('preserves an already-inlined launchTag (never overwrites the backend value)', () => {
    const a = obj(21, 'active_satellite', 'LEO');
    a.launchTag = '1998-067';           // backend value, OBJECT_ID says 2000-001A
    buildCatalogResult([a]);
    assert.equal(a.launchTag, '1998-067');
  });

  it('leaves a non-COSPAR OBJECT_ID unstamped and never invents owner', () => {
    const a = obj(22, 'active_satellite', 'LEO');
    a.omm.OBJECT_ID = 'UNKNOWN';
    buildCatalogResult([a]);
    assert.equal(a.launchTag, undefined);
    assert.equal(a.owner, undefined);
  });
});
