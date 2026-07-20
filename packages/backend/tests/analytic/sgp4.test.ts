// P3 S3 Part C — sgp4.ts provider tests.
// Spec: my_plans/marvin/p3/S3_sgp4_provider_astro.md "Tests" #2-8.
// (#1, the golden cross-check, lives in astro.test.ts.)
//
// Fixtures: 2 REAL OMM records pinned from the live cache (probed once via
// npx tsx, then hardcoded here) — ISS (25544, LEO) + SYNCOM 2 (634, GEO/deep-
// space resonant) — plus one deliberately corrupted OMM.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execute, validateProgram } from '@orbitwatch/analytic';
import { createSgp4Provider } from '../../src/analytic/providers/sgp4.js';
import { createCatalogProvider } from '../../src/analytic/providers/catalog.js';
import { createEnrichmentProvider } from '../../src/analytic/providers/enrichment.js';
import { DataSourceRegistry } from '../../src/analytic/registry.js';
import type { EnrichedTLEObject, VersionInfo } from '../../src/types/index.js';

const ISS_OMM = {
  OBJECT_NAME: 'ISS (ZARYA)', OBJECT_ID: '1998-067A', EPOCH: '2026-07-18T20:42:49.520160Z',
  MEAN_MOTION: 15.49045026, ECCENTRICITY: 0.00068076, INCLINATION: 51.6317,
  RA_OF_ASC_NODE: 143.3357, ARG_OF_PERICENTER: 311.9483, MEAN_ANOMALY: 48.0925,
  EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: 25544, ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 57666, BSTAR: 0.0000819388, MEAN_MOTION_DOT: 0.00004074, MEAN_MOTION_DDOT: 0,
} as unknown as EnrichedTLEObject['omm'];

const GEO_OMM = {
  OBJECT_NAME: 'SYNCOM 2 (A 26)', OBJECT_ID: '1963-031A', EPOCH: '2026-07-17T18:55:38.750880Z',
  MEAN_MOTION: 1.00266476, ECCENTRICITY: 0.00073267, INCLINATION: 29.9172,
  RA_OF_ASC_NODE: 300.0136, ARG_OF_PERICENTER: 203.5635, MEAN_ANOMALY: 141.6747,
  EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: 634, ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 23066, BSTAR: 0, MEAN_MOTION_DOT: -2.2e-7, MEAN_MOTION_DDOT: 0,
} as unknown as EnrichedTLEObject['omm'];

// NaN epoch/elements — json2satrec doesn't throw on this (probed), but yields
// jdsatepoch=NaN, which the propagation-window guard's finite check rejects
// before ever calling propagate().
const BAD_OMM = {
  OBJECT_NAME: 'GARBAGE', OBJECT_ID: 'x', EPOCH: 'not-a-date',
  MEAN_MOTION: NaN, ECCENTRICITY: NaN, INCLINATION: NaN,
  RA_OF_ASC_NODE: NaN, ARG_OF_PERICENTER: NaN, MEAN_ANOMALY: NaN,
  EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: 999999, ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 0, BSTAR: NaN, MEAN_MOTION_DOT: NaN, MEAN_MOTION_DDOT: NaN,
} as unknown as EnrichedTLEObject['omm'];

const ISS_EPOCH_MS = Date.parse('2026-07-18T20:42:49.520160Z');
// Probed: epoch+30min puts ISS directly over (44.6147, 16.9222) with the
// observer in darkness and the satellite still sunlit — a genuine visible-pass
// geometry (elevation~90, range~425km, observerDark=true, eclipsed=false).
const PASS_T_MS = ISS_EPOCH_MS + 30 * 60_000;
const PASS_OBS = { latDeg: 44.61467652441952, lonDeg: 16.922182826897185, altKm: 0 };
const PASS_ANTIPODE_OBS = { latDeg: -44.61467652441952, lonDeg: -163.0778171731028, altKm: 0 };

function iss(omm = ISS_OMM): EnrichedTLEObject {
  return {
    noradId: 25544, name: 'ISS (ZARYA)', objectType: 'satellite', category: 'active_satellite',
    regime: 'LEO', countryCode: 'US', launchDate: '1998-11-20',
    period: 92.9, apogee: 424.148, perigee: 414.893, inclination: 51.6317, rcsSize: 'LARGE',
    epoch: '2026-07-18T20:42:49.520160Z', sectors: [], purpose: 'space_science', status: 'in_orbit',
    omm,
  };
}

function geo(): EnrichedTLEObject {
  return {
    noradId: 634, name: 'SYNCOM 2 (A 26)', objectType: 'satellite', category: 'inactive_satellite',
    regime: 'GEO', countryCode: 'US', launchDate: '1963-07-26',
    period: 1436, apogee: 35818.979, perigee: 35757.192, inclination: 29.9172, rcsSize: 'MEDIUM',
    epoch: '2026-07-17T18:55:38.750880Z', sectors: [], purpose: 'other', status: 'in_orbit',
    omm: GEO_OMM,
  };
}

function badFixture(): EnrichedTLEObject {
  return {
    noradId: 999999, name: 'GARBAGE', objectType: 'debris', category: 'debris',
    regime: 'LEO', countryCode: '', launchDate: null,
    period: 0, apogee: 0, perigee: 0, inclination: 0, rcsSize: null,
    epoch: '2026-01-01T00:00:00Z', sectors: [], purpose: 'other', status: 'in_orbit',
    omm: BAD_OMM,
  };
}

function makeVersion(v: string): VersionInfo {
  return { version: v, count: 1, byteSize: 1 };
}

function providerOver(objs: EnrichedTLEObject[], visualIds: Set<number> | null = null) {
  return createSgp4Provider({
    readCatalog: () => objs,
    readVersion: () => makeVersion('v1'),
    getVisualNoradIds: () => visualIds,
  });
}

// ── Test 2 — satrec caching persists across reads within a stable version ────
// Direct propagate()-call counting isn't feasible: satellite.js's ESM/CJS
// interop exports propagate as a non-configurable getter (verified — assigning
// to it throws "Cannot set property propagate of #<Object> which has only a
// getter"), so it can't be spied/wrapped. Instead: prove the cache is load-
// bearing by mutating the source OMM in place AFTER the first read (no version
// bump) and confirming the second read is unaffected — if the satrec/state
// were rebuilt from the (now-different) source on every call, this would fail.
describe('createSgp4Provider — caching persists within a stable catalog version', () => {
  it('mutating the source OMM after the first read does not change the second read', () => {
    const fixture = iss();
    const provider = providerOver([fixture]);

    const before = provider.getField(25544, 'altitudeKm', PASS_T_MS);
    assert.ok(typeof before === 'number');

    // Mutate in place — a drastically different MEAN_MOTION would change the
    // propagated altitude if the satrec were rebuilt from this object again.
    fixture.omm = { ...fixture.omm, MEAN_MOTION: 999 } as EnrichedTLEObject['omm'];

    const after = provider.getField(25544, 'altitudeKm', PASS_T_MS);
    assert.equal(after, before, 'cached satrec/state must survive an in-place source mutation');
  });
});

// ── Test 3 — bad OMM ──────────────────────────────────────────────────────────
describe('createSgp4Provider — bad OMM', () => {
  const provider = providerOver([badFixture()]);
  const FIELDS = ['speedKmS', 'altitudeKm', 'latDeg', 'lonDeg', 'eclipsed'];

  it('every live field is null, no throw', () => {
    for (const f of FIELDS) {
      assert.equal(provider.getField(999999, f, Date.now()), null, `${f} must be null for a bad OMM`);
    }
  });

  it('second read after the first is still null (no throw on the cached-null path)', () => {
    for (const f of FIELDS) {
      assert.equal(provider.getField(999999, f, Date.now() + 1000), null);
    }
  });
});

// ── Test 4 — propagation window ───────────────────────────────────────────────
describe('createSgp4Provider — propagation window guard', () => {
  const provider = providerOver([iss()]);

  it('61 days past epoch -> null (guard fires)', () => {
    const t = ISS_EPOCH_MS + 61 * 86_400_000;
    assert.equal(provider.getField(25544, 'altitudeKm', t), null);
  });

  it('1 hour past epoch -> non-null', () => {
    const t = ISS_EPOCH_MS + 3600_000;
    assert.notEqual(provider.getField(25544, 'altitudeKm', t), null);
  });
});

// ── Test 5 — physics sanity ────────────────────────────────────────────────────
describe('createSgp4Provider — physics sanity at a fixed instant', () => {
  const provider = providerOver([iss(), geo()]);

  it('ISS altitudeKm is in (350, 460)', () => {
    const alt = provider.getField(25544, 'altitudeKm', PASS_T_MS) as number;
    assert.ok(alt > 350 && alt < 460, `altitudeKm=${alt}`);
  });

  it('ISS speedKmS is in (7.5, 7.8)', () => {
    const speed = provider.getField(25544, 'speedKmS', PASS_T_MS) as number;
    assert.ok(speed > 7.5 && speed < 7.8, `speedKmS=${speed}`);
  });

  it('GEO fixture altitude is ~35786 +/- 300 km', () => {
    const alt = provider.getField(634, 'altitudeKm', PASS_T_MS) as number;
    assert.ok(Math.abs(alt - 35786) < 300, `altitudeKm=${alt}`);
  });

  it('distToKm(iss, iss) === 0', () => {
    assert.equal(provider.distToKm!(25544, 25544, PASS_T_MS), 0);
  });

  it('distToKm(iss, geo) > 30,000 km', () => {
    const d = provider.distToKm!(25544, 634, PASS_T_MS) as number;
    assert.ok(d > 30_000, `distToKm=${d}`);
  });
});

// ── Test 6 — observer fns ──────────────────────────────────────────────────────
describe('createSgp4Provider — observer fns', () => {
  const provider = providerOver([iss(), geo()]);

  it('observer directly under ISS -> elevationDeg > 80', () => {
    const el = provider.elevationDeg!(25544, PASS_OBS, PASS_T_MS) as number;
    assert.ok(el > 80, `elevationDeg=${el}`);
  });

  it('antipodal observer -> negative elevation', () => {
    const el = provider.elevationDeg!(25544, PASS_ANTIPODE_OBS, PASS_T_MS) as number;
    assert.ok(el < 0, `elevationDeg=${el}`);
  });

  it('rangeKm ~= altitudeKm for the overhead case (+/-5%)', () => {
    const range = provider.rangeKm!(25544, PASS_OBS, PASS_T_MS) as number;
    const alt = provider.getField(25544, 'altitudeKm', PASS_T_MS) as number;
    assert.ok(Math.abs(range - alt) / alt < 0.05, `range=${range}, alt=${alt}`);
  });

  it('observerDark: true under ISS at the probed pass instant', () => {
    assert.equal(provider.observerDark!(PASS_OBS, PASS_T_MS), true);
  });

  it('observerDark: false at the daylit antipode', () => {
    assert.equal(provider.observerDark!(PASS_ANTIPODE_OBS, PASS_T_MS), false);
  });
});

// ── Test 7 — visuallyVisible ───────────────────────────────────────────────────
describe('createSgp4Provider — visuallyVisible', () => {
  it('null when the visual-list dep returns null', () => {
    const provider = providerOver([iss()], null);
    assert.equal(provider.visuallyVisible!(25544, PASS_OBS, PASS_T_MS), null);
  });

  it('curated + elevated + in-range + dark + uneclipsed -> true', () => {
    const provider = providerOver([iss()], new Set([25544]));
    assert.equal(provider.visuallyVisible!(25544, PASS_OBS, PASS_T_MS), true);
  });

  it('not curated (same geometry) -> false', () => {
    const provider = providerOver([iss()], new Set([999])); // ISS not in the curated set
    assert.equal(provider.visuallyVisible!(25544, PASS_OBS, PASS_T_MS), false);
  });

  // Regression (audit finding): the curated list must be re-read after its TTL,
  // not memoized forever — a null first read (visual-cache.json missing at boot)
  // previously pinned the feature off for the process lifetime.
  it('re-reads the curated list after the TTL (null-at-boot recovers)', () => {
    let list: Set<number> | null = null; // file missing at first call
    const provider = createSgp4Provider({
      readCatalog: () => [iss()],
      readVersion: () => makeVersion('v1'),
      getVisualNoradIds: () => list,
      visualIdsTtlMs: 0, // test seam: expire immediately
    });
    assert.equal(provider.visuallyVisible!(25544, PASS_OBS, PASS_T_MS), null);

    list = new Set([25544]); // cron wrote the file
    assert.equal(provider.visuallyVisible!(25544, PASS_OBS, PASS_T_MS), true);

    list = new Set([999]); // membership change also picked up
    assert.equal(provider.visuallyVisible!(25544, PASS_OBS, PASS_T_MS), false);
  });
});

// ── Test 8 — chain end-to-end ──────────────────────────────────────────────────
describe('sgp4 in the real chain — [catalog, enrichment, sgp4] via execute()', () => {
  it('meanMotionDot (catalog) + altitudeKm (sgp4) filter -> only ISS matches', () => {
    const deps = { readCatalog: () => [iss(), geo()], readVersion: () => makeVersion('v1') };
    const catalog = createCatalogProvider(deps);
    const enrichment = createEnrichmentProvider();
    const sgp4 = createSgp4Provider({ ...deps, getVisualNoradIds: () => null });

    const reg = new DataSourceRegistry();
    reg.registerSpine('live', catalog);
    reg.register('live', catalog);
    reg.register('live', enrichment);
    reg.register('live', sgp4);

    const program = {
      v: 1 as const,
      universe: 'live' as const,
      timeBinding: { mode: 'now' as const },
      interpretation: 'test',
      pipeline: [
        {
          op: 'filter' as const,
          where: {
            op: 'and' as const,
            args: [
              { op: '>' as const, args: [{ field: 'meanMotionDot' }, { lit: 1e-5 }] },
              // GEO's altitude (~35,786 km) rules it out; ISS's (~425 km) passes —
              // this is what forces the sgp4 live-plane field into the scan.
              { op: '<' as const, args: [{ field: 'altitudeKm' }, { lit: 1000 }] },
            ],
          },
        },
      ],
      output: { shape: 'ids' as const },
    };
    const v = validateProgram(program, { nowMs: PASS_T_MS });
    assert.equal(v.ok, true, v.ok ? '' : JSON.stringify(v.issues));

    const source = reg.buildSource('live')!;
    const outcome = execute(program, { live: source }, { nowMs: PASS_T_MS });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(Array.from(outcome.result.ids!), [25544]);
  });
});
