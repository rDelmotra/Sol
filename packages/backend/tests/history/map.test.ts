import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OMMJsonObject } from 'satellite.js';
import { mapEnriched, objectTypeFromCategory } from '../../src/history/ingest/map.js';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';

// Pure mapping test — no DB. Runs under `npm test` without a database.

function makeOmm(noradId: number, epoch: string): OMMJsonObject {
  return {
    OBJECT_NAME: `OBJ-${noradId}`,
    OBJECT_ID: '1998-067A',
    EPOCH: epoch,
    MEAN_MOTION: 15.5,
    ECCENTRICITY: 0.0007776,
    INCLINATION: 51.64,
    RA_OF_ASC_NODE: 337.664,
    ARG_OF_PERICENTER: 35.531,
    MEAN_ANOMALY: 330.368,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: noradId,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 10001,
    BSTAR: 0.0001027,
    MEAN_MOTION_DOT: 0.00016717,
    MEAN_MOTION_DDOT: 0,
  };
}

function makeEnriched(overrides: Partial<EnrichedTLEObject> = {}): EnrichedTLEObject {
  const epoch = overrides.epoch ?? '2026-06-25T12:34:56.000Z';
  return {
    noradId: 25544,
    name: 'ISS (ZARYA)',
    omm: makeOmm(25544, epoch),
    objectType: 'satellite',
    category: 'active_satellite',
    regime: 'LEO',
    countryCode: 'US',
    launchDate: '1998-11-20',
    period: 92.9,
    apogee: 421,
    perigee: 416,
    inclination: 51.64,
    rcsSize: 'LARGE',
    epoch,
    sectors: [],
    purpose: 'other',
    status: 'in_orbit',
    ...overrides,
  };
}

describe('mapEnriched', () => {
  it('derives utc_day from the epoch (UTC) and copies fact/dim fields', () => {
    const mapped = mapEnriched(makeEnriched());
    assert.ok(mapped);

    assert.equal(mapped.fact.utc_day, '2026-06-25');
    assert.equal(mapped.dim.utc_day, '2026-06-25');
    assert.equal(mapped.fact.epoch, '2026-06-25T12:34:56.000Z');

    // OMM elements land in the fact as numbers.
    assert.equal(mapped.fact.mean_motion, 15.5);
    assert.equal(mapped.fact.eccentricity, 0.0007776);
    assert.equal(mapped.fact.inclination, 51.64);
    assert.equal(mapped.fact.bstar, 0.0001027);
    assert.equal(mapped.fact.classification_type, 'U');
    assert.equal(mapped.fact.element_set_no, 999);

    // Enrichment carried straight through.
    assert.equal(mapped.fact.category, 'active_satellite');
    assert.equal(mapped.fact.regime, 'LEO');
    assert.equal(mapped.fact.period, 92.9);
    assert.equal(mapped.fact.apogee_km, 421);
    assert.equal(mapped.fact.perigee_km, 416);

    // Dim metadata.
    assert.equal(mapped.dim.norad_id, 25544);
    assert.equal(mapped.dim.object_name, 'ISS (ZARYA)');
    assert.equal(mapped.dim.object_id, '1998-067A');
    assert.equal(mapped.dim.country_code, 'US');
    assert.equal(mapped.dim.launch_date, '1998-11-20');
    assert.equal(mapped.dim.rcs_size, 'LARGE');
  });

  it('buckets a late-UTC epoch into the correct day (no local-time drift)', () => {
    const mapped = mapEnriched(makeEnriched({ epoch: '2026-06-25T23:59:59.000Z' }));
    assert.ok(mapped);
    assert.equal(mapped.fact.utc_day, '2026-06-25');
  });

  it('returns null for an unparseable epoch', () => {
    assert.equal(mapEnriched(makeEnriched({ epoch: 'not-a-date' })), null);
  });

  it('normalizes a missing launch date to null', () => {
    const mapped = mapEnriched(makeEnriched({ launchDate: null }));
    assert.ok(mapped);
    assert.equal(mapped.dim.launch_date, null);
  });

  it('maps category → objectType the same way the cron does', () => {
    assert.equal(objectTypeFromCategory('active_satellite'), 'satellite');
    assert.equal(objectTypeFromCategory('inactive_satellite'), 'satellite');
    assert.equal(objectTypeFromCategory('rocket_body'), 'rocket_body');
    assert.equal(objectTypeFromCategory('debris'), 'debris');
    assert.equal(objectTypeFromCategory('unknown'), 'unknown');
    assert.equal(objectTypeFromCategory('deep_space'), 'unknown');
  });
});
