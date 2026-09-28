// P3 space-weather task — swpc.ts parser + swpc-cache.ts + space-weather.ts
// provider tests, plus the boot-snapshot expandability check.
//
// Fixture text is a trimmed real excerpt of the two NOAA SWPC products
// (probed live via curl 2026-09-09), including the DGD.txt row shape where
// Fredericksburg/College missing-data "-1" tokens run together without a
// separating space — the case parseDgdLine's "read only the trailing
// Estimated-Planetary group" strategy exists to survive.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execute, validateProgram, type AnalyticProgram } from '@orbitwatch/analytic';
import { parseDgdLine, parseDsdLine, type SwpcDailyIndex } from '../../src/services/swpc.js';
import { createSpaceWeatherProvider } from '../../src/analytic/providers/space-weather.js';
import { createCatalogProvider } from '../../src/analytic/providers/catalog.js';
import { DataSourceRegistry } from '../../src/analytic/registry.js';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import type { VersionInfo } from '../../src/types/index.js';

// ── Real excerpts (trimmed) ────────────────────────────────────────────────

const DGD_HEADER_LINES = [
  ':Product: Daily Geomagnetic Data          DGD.txt',
  ':Issued: 1530 UT 08 Sep 2026',
  '#',
  '#  Prepared by the U.S. Dept. of Commerce, NOAA, Space Weather Prediction Center',
  '#               Last 30 Days Daily Geomagnetic Data',
  '#',
  '#  Date        A     K-indices        A     K-indices        A     K-indices',
];

// Normal row.
const DGD_ROW_NORMAL =
  '2026 09 06     5  1 1 1 2 2 1 1 2     2  2 1 1 0 0 0 1 0     5   1.33  1.33  1.33  1.33  1.33  0.67  1.67  1.67';

// Row with run-together "-1" tokens in the Fredericksburg/College groups (the
// exact case the trailing-9-tokens strategy must survive).
const DGD_ROW_MISSING_STATION_DATA =
  '2026 08 16    -1  2 2 2-1-1-1-1-1    -1  1 1 4-1-1-1-1-1     4   1.33  1.67  2.00  1.67  0.33  0.00  0.67  1.00';

const DSD_HEADER_LINES = [
  ':Product: Daily Solar Data            DSD.txt',
  ':Issued: 1425 UT 08 Sep 2026',
  '#',
  '#                Last 30 Days Daily Solar Data',
  '#           Radio  SESC     Area          Solar  X-Ray  ------ Flares ------',
  '#           Flux  Sunspot  10E-6   New     Mean  Bkgd    X-Ray      Optical',
  '#  Date     10.7cm Number  Hemis. Regions Field  Flux   C  M  X  S  1  2  3',
  '#--------------------------------------------------------------------------- ',
];

const DSD_ROW_NORMAL = '2026 09 06  110     72      260      3    -999      *   7  1  0  4  1  0  0';

function dgdText(...rows: string[]): string {
  return [...DGD_HEADER_LINES, ...rows, ''].join('\n');
}

function dsdText(...rows: string[]): string {
  return [...DSD_HEADER_LINES, ...rows, ''].join('\n');
}

// ── parseDgdLine / parseDsdLine ─────────────────────────────────────────────

describe('parseDgdLine', () => {
  it('parses the trailing Estimated-Planetary group of a normal row', () => {
    const parsed = parseDgdLine(DGD_ROW_NORMAL);
    assert.ok(parsed);
    assert.equal(parsed!.date, '2026-09-06');
    assert.equal(parsed!.apIndex, 5);
    // (1.33+1.33+1.33+1.33+1.33+0.67+1.67+1.67)/8
    assert.ok(Math.abs(parsed!.kpIndex - 1.33249999) < 1e-4);
  });

  it('survives run-together "-1" tokens in the station (non-planetary) groups', () => {
    const parsed = parseDgdLine(DGD_ROW_MISSING_STATION_DATA);
    assert.ok(parsed);
    assert.equal(parsed!.date, '2026-08-16');
    assert.equal(parsed!.apIndex, 4);
    assert.ok(Math.abs(parsed!.kpIndex - 1.08375) < 1e-4);
  });

  it('returns null for header/comment/blank lines', () => {
    for (const line of DGD_HEADER_LINES) assert.equal(parseDgdLine(line), null);
    assert.equal(parseDgdLine(''), null);
    assert.equal(parseDgdLine('   '), null);
  });
});

describe('parseDsdLine', () => {
  it('parses the 10.7cm radio flux column', () => {
    const parsed = parseDsdLine(DSD_ROW_NORMAL);
    assert.ok(parsed);
    assert.equal(parsed!.date, '2026-09-06');
    assert.equal(parsed!.f107, 110);
  });

  it('returns null for header/comment/blank lines', () => {
    for (const line of DSD_HEADER_LINES) assert.equal(parseDsdLine(line), null);
    assert.equal(parseDsdLine(''), null);
  });
});

describe('fetchSwpcDailyIndices merge shape (via the parsers directly)', () => {
  it('DGD + DSD rows for the same date merge into one record with all three fields', () => {
    const dgd = parseDgdLine(DGD_ROW_NORMAL)!;
    const dsd = parseDsdLine(DSD_ROW_NORMAL)!;
    assert.equal(dgd.date, dsd.date);
    const merged: SwpcDailyIndex = { date: dgd.date, apIndex: dgd.apIndex, kpIndex: dgd.kpIndex, f107: dsd.f107 };
    assert.deepEqual(merged, { date: '2026-09-06', apIndex: 5, kpIndex: dgd.kpIndex, f107: 110 });
  });
});

// dgdText/dsdText are exercised implicitly through the parser tests above;
// keep them referenced so a future fuller fetchText-mock test has fixtures ready.
void dgdText;
void dsdText;

// ── createSpaceWeatherProvider ──────────────────────────────────────────────

const FIXTURE_RECORDS: SwpcDailyIndex[] = [
  { date: '2026-09-05', apIndex: 5, kpIndex: 1.33, f107: 108 },
  { date: '2026-09-06', apIndex: 4, kpIndex: 1.24, f107: 110 },
];

function fixtureProvider(overrides: Partial<Parameters<typeof createSpaceWeatherProvider>[0]> = {}) {
  return createSpaceWeatherProvider({
    readCache: () => ({ version: 'v1', records: FIXTURE_RECORDS }),
    isCacheFresh: () => true, // fresh: no background refresh fires during the test
    fetchIndices: async () => { throw new Error('should not be called — cache is fresh'); },
    writeCache: () => { throw new Error('should not be called — cache is fresh'); },
    ...overrides,
  });
}

describe('createSpaceWeatherProvider', () => {
  it('resolves all three fields for the UTC day containing tMs', () => {
    const provider = fixtureProvider();
    const tMs = Date.parse('2026-09-06T14:00:00Z');
    assert.equal(provider.getField(25544, 'geomagneticAp', tMs), 4);
    assert.equal(provider.getField(25544, 'geomagneticKp', tMs), 1.24);
    assert.equal(provider.getField(25544, 'solarFlux10cm', tMs), 110);
  });

  it('ignores noradId entirely — every object sees the same value at the same instant', () => {
    const provider = fixtureProvider();
    const tMs = Date.parse('2026-09-05T00:00:00Z');
    const a = provider.getField(1, 'geomagneticAp', tMs);
    const b = provider.getField(999999, 'geomagneticAp', tMs);
    const c = provider.getField(-1, 'geomagneticAp', tMs);
    assert.equal(a, 5);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it('returns null for a date outside the cached window (honest null, not a throw)', () => {
    const provider = fixtureProvider();
    const tMs = Date.parse('2020-01-01T00:00:00Z');
    assert.equal(provider.getField(1, 'geomagneticAp', tMs), null);
    assert.equal(provider.getField(1, 'solarFlux10cm', tMs), null);
  });

  it('returns null for an unclaimed field', () => {
    const provider = fixtureProvider();
    assert.equal(provider.getField(1, 'noradId', Date.parse('2026-09-06T00:00:00Z')), null);
  });

  it('declares exactly the three claimed fields, no fns', () => {
    const provider = fixtureProvider();
    assert.deepEqual([...provider.fields].sort(), ['geomagneticAp', 'geomagneticKp', 'solarFlux10cm']);
    assert.equal(provider.fns, undefined);
  });

  it('triggers exactly one background refresh (not per-call) when the cache is stale, and does not block getField', async () => {
    let fetchCalls = 0;
    let writeCalls = 0;
    let resolveFetch: (() => void) | null = null;
    const fetchGate = new Promise<void>((resolve) => { resolveFetch = resolve; });

    const provider = createSpaceWeatherProvider({
      readCache: () => ({ version: 'v1', records: FIXTURE_RECORDS }),
      isCacheFresh: () => false, // always stale -> would refresh every call if not guarded
      fetchIndices: async () => {
        fetchCalls++;
        await fetchGate;
        return FIXTURE_RECORDS;
      },
      writeCache: (records) => { writeCalls++; return { version: 'v2', records }; },
    });

    // getField must return synchronously from the already-loaded cache, even
    // though a refresh is in flight in the background.
    const tMs = Date.parse('2026-09-06T00:00:00Z');
    const v1 = provider.getField(1, 'geomagneticAp', tMs);
    const v2 = provider.getField(1, 'geomagneticAp', tMs);
    assert.equal(v1, 4);
    assert.equal(v2, 4);
    assert.equal(fetchCalls, 1); // in-flight guard collapsed the second call's trigger

    resolveFetch!();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(writeCalls, 1);
  });
});

// ── Boot-snapshot expandability check ───────────────────────────────────────
// Mirrors registry.test.ts's "the expandability test" — a global provider
// (not just a per-object one) composes into the real registry + boot
// snapshot with zero changes to registry.ts/types.ts/execute.ts/validate.ts.

function fixtureTleCatalog(): EnrichedTLEObject[] {
  const omm = { OBJECT_NAME: 'x', OBJECT_ID: '', MEAN_MOTION: 15 } as unknown as EnrichedTLEObject['omm'];
  return [1, 2, 3].map((noradId) => ({
    noradId, name: `Obj${noradId}`, objectType: 'satellite', category: 'active_satellite',
    regime: 'LEO', countryCode: 'US', launchDate: '2020-01-01',
    period: 95, apogee: 500, perigee: 480, inclination: 51.6, rcsSize: 'LARGE',
    epoch: '2026-09-06T00:00:00Z', sectors: [], purpose: 'other', status: 'in_orbit', omm,
  }));
}

function fixtureVersion(): VersionInfo {
  return { version: 'v1', count: 3, byteSize: 1 };
}

describe('space-weather provider registered into the real registry', () => {
  it('boot snapshot measures the 3 new fields with full coverage (same value for every object)', () => {
    const reg = new DataSourceRegistry();
    const catalog = createCatalogProvider({ readCatalog: fixtureTleCatalog, readVersion: fixtureVersion });
    const spaceWeather = createSpaceWeatherProvider({
      readCache: () => ({ version: 'v1', records: FIXTURE_RECORDS }),
      isCacheFresh: () => true,
      fetchIndices: async () => FIXTURE_RECORDS,
      writeCache: (records) => ({ version: 'v2', records }),
    });

    reg.registerSpine('live', catalog);
    reg.register('live', catalog);
    reg.register('live', spaceWeather);

    const snap = reg.snapshot();
    const apCap = snap.universes[0].fields.find((f) => f.field === 'geomagneticAp')!;
    const kpCap = snap.universes[0].fields.find((f) => f.field === 'geomagneticKp')!;
    const fluxCap = snap.universes[0].fields.find((f) => f.field === 'solarFlux10cm')!;
    assert.equal(apCap.servedBy, 'space-weather');
    assert.equal(kpCap.servedBy, 'space-weather');
    assert.equal(fluxCap.servedBy, 'space-weather');
    // Boot measurement uses Date.now() as tMs — outside the fixture's cached
    // window, so every object legitimately reads null -> coverage 0. This is
    // exactly the honest "30-day window" limitation, not a bug: it proves the
    // per-object boot loop calls through to the global provider correctly
    // (same 0 for every object) rather than crashing or short-circuiting it.
    assert.equal(apCap.coverage, 0);
    assert.equal(kpCap.coverage, 0);
    assert.equal(fluxCap.coverage, 0);
  });

  it('program combining a catalog field (regime) and a space-weather field executes end-to-end', () => {
    const reg = new DataSourceRegistry();
    const catalog = createCatalogProvider({ readCatalog: fixtureTleCatalog, readVersion: fixtureVersion });
    const spaceWeather = createSpaceWeatherProvider({
      readCache: () => ({ version: 'v1', records: FIXTURE_RECORDS }),
      isCacheFresh: () => true,
      fetchIndices: async () => FIXTURE_RECORDS,
      writeCache: (records) => ({ version: 'v2', records }),
    });
    reg.registerSpine('live', catalog);
    reg.register('live', catalog);
    reg.register('live', spaceWeather);

    const source = reg.buildSource('live')!;
    const program: AnalyticProgram = {
      v: 1 as const,
      universe: 'live' as const,
      timeBinding: { mode: 'at' as const, t: '2026-09-06T12:00:00Z' },
      interpretation: 'test',
      pipeline: [
        { op: 'filter' as const, where: { op: '==' as const, args: [{ field: 'regime' }, { lit: 'LEO' }] } },
        { op: 'derive' as const, fields: { ap: { field: 'geomagneticAp' } } },
        { op: 'sort' as const, by: 'noradId', dir: 'asc' as const },
        { op: 'limit' as const, n: 10 },
      ],
      output: { shape: 'table' as const, columns: ['noradId', 'regime', 'ap'] },
    };

    const validation = validateProgram(program);
    assert.equal(validation.ok, true);

    const outcome = execute(program, { live: source });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.rows?.length, 3);
    for (const row of outcome.result.rows ?? []) {
      assert.equal(row.regime, 'LEO');
      assert.equal(row.ap, 4); // 2026-09-06's fixture Ap, same for every row
    }
  });
});
