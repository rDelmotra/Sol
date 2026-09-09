// Place-name gazetteer tests — Natural Earth grounding for observer coordinates.
// Everything here runs against a small inline GeoJSON fixture; nothing touches
// the network (parseGazetteerGeoJson/createGazetteerFromRecords are pure, and
// the cache round-trip tests use a temp CACHE_DIR, mirroring
// tests/cache/swpc-cache.test.ts's pattern).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  parseGazetteerGeoJson,
  createGazetteerFromRecords,
  extractPlaceCandidates,
  getDefaultGazetteer,
} from '../../src/services/gazetteer.js';
import {
  readGazetteerCache,
  writeGazetteerCache,
  isGazetteerCacheFresh,
  GAZETTEER_CACHE_TTL_MS,
} from '../../src/cache/gazetteer-cache.js';

// ── Fixture: two Sydneys (different pop_max), one Bengaluru (alt name lives in
// namepar/ls_name/meganame, NOT namealt — the real defect this feature fixes),
// and one ordinary city (Tokyo). Coordinates are the REAL Natural Earth values
// (verified by a live fetch) so the [lon,lat]-order test has a known-truth
// anchor: Sydney AU's longitude is 151.212548, not anywhere near its latitude
// -33.871373 — a swapped-order bug would fail the "valid latitude" assertion.
const FIXTURE_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        name: 'Sydney', nameascii: 'Sydney', namealt: null, ls_name: null, meganame: null, namepar: null,
        adm0name: 'Australia', adm1name: 'New South Wales', pop_max: 4630000, ne_id: 'syd-au',
      },
      geometry: { type: 'Point', coordinates: [151.212548, -33.871373] },
    },
    {
      type: 'Feature',
      properties: {
        name: 'Sydney', nameascii: 'Sydney', namealt: null, ls_name: null, meganame: null, namepar: null,
        adm0name: 'Canada', adm1name: 'Nova Scotia', pop_max: 37538, ne_id: 'syd-ca',
      },
      geometry: { type: 'Point', coordinates: [-60.179981, 46.066114] },
    },
    {
      type: 'Feature',
      properties: {
        name: 'Bengaluru', nameascii: 'Bengaluru', namealt: null,
        ls_name: 'Bangalore', meganame: 'Bangalore', namepar: 'Bangalore',
        adm0name: 'India', adm1name: 'Karnataka', pop_max: 6787000, ne_id: 'blr-in',
      },
      geometry: { type: 'Point', coordinates: [77.558064, 12.971941] },
    },
    {
      type: 'Feature',
      properties: {
        name: 'Tokyo', nameascii: 'Tokyo', namealt: null, ls_name: null, meganame: null, namepar: null,
        adm0name: 'Japan', adm1name: 'Tokyo', pop_max: 35676000, ne_id: 'tok-jp',
      },
      geometry: { type: 'Point', coordinates: [139.749462, 35.686963] },
    },
  ],
};

// ── parseGazetteerGeoJson ──────────────────────────────────────────────────────

describe('parseGazetteerGeoJson', () => {
  it('reads geometry.coordinates as [lon, lat] — a swapped-order bug is the single most likely defect here', () => {
    const records = parseGazetteerGeoJson(FIXTURE_GEOJSON);
    const sydneyAu = records.find((r) => r.name === 'Sydney' && r.adm0Name === 'Australia');
    assert.ok(sydneyAu);
    assert.equal(sydneyAu!.lonDeg, 151.212548);
    assert.equal(sydneyAu!.latDeg, -33.871373);
    // Explicit anti-swap assertions: a valid latitude is always in [-90,90];
    // Sydney's real longitude (151.21) is not, so a swap would trip this.
    assert.ok(Math.abs(sydneyAu!.latDeg) <= 90, 'latDeg must be a valid latitude, not the swapped longitude');
    assert.ok(Math.abs(sydneyAu!.lonDeg) > 90, 'lonDeg must be the longitude (~151.21), not the swapped latitude');
  });

  it('maps namepar/ls_name/meganame (Bengaluru\'s "Bangalore" alt name lives there, not namealt)', () => {
    const records = parseGazetteerGeoJson(FIXTURE_GEOJSON);
    const bengaluru = records.find((r) => r.name === 'Bengaluru');
    assert.ok(bengaluru);
    assert.equal(bengaluru!.nameAlt, null);
    assert.equal(bengaluru!.namePar, 'Bangalore');
    assert.equal(bengaluru!.lsName, 'Bangalore');
    assert.equal(bengaluru!.megaName, 'Bangalore');
  });

  it('skips malformed features (missing name, or empty/missing coordinates) without throwing', () => {
    const malformed = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } }, // no name
        { type: 'Feature', properties: { name: 'NoCoords' }, geometry: { type: 'Point', coordinates: [] } },
        { type: 'Feature', properties: { name: 'Good' }, geometry: { type: 'Point', coordinates: [10, 20] } },
      ],
    };
    const records = parseGazetteerGeoJson(malformed);
    assert.equal(records.length, 1);
    assert.equal(records[0].name, 'Good');
  });

  it('throws on a non-FeatureCollection input (the network loader wraps this fail-soft, not this pure function)', () => {
    assert.throws(() => parseGazetteerGeoJson({ not: 'geojson' }));
    assert.throws(() => parseGazetteerGeoJson(null));
    assert.throws(() => parseGazetteerGeoJson('a string'));
  });
});

// ── createGazetteerFromRecords / resolvePlace ──────────────────────────────────

describe('createGazetteerFromRecords — resolvePlace', () => {
  const records = parseGazetteerGeoJson(FIXTURE_GEOJSON);
  const gaz = createGazetteerFromRecords(records, 'test-v1');

  it('resolves an unambiguous ordinary city (Tokyo) with the exact source coordinates', () => {
    const hit = gaz.resolvePlace('Tokyo');
    assert.ok(hit);
    assert.equal(hit!.name, 'Tokyo');
    assert.equal(hit!.lonDeg, 139.749462);
    assert.equal(hit!.latDeg, 35.686963);
    assert.equal(hit!.countryName, 'Japan');
    assert.equal(hit!.ambiguousWith, undefined);
  });

  it('ambiguity: "Sydney" picks the higher pop_max (Australia) and reports the runner-up (Nova Scotia) — never a silent pick', () => {
    const hit = gaz.resolvePlace('Sydney');
    assert.ok(hit);
    assert.equal(hit!.countryName, 'Australia');
    assert.equal(hit!.admin1, 'New South Wales');
    assert.equal(hit!.population, 4630000);
    assert.ok(hit!.ambiguousWith, 'must disclose the runner-up rather than silently disambiguating');
    assert.equal(hit!.ambiguousWith!.countryName, 'Canada');
    assert.equal(hit!.ambiguousWith!.admin1, 'Nova Scotia');
    assert.equal(hit!.ambiguousWith!.population, 37538);
  });

  it('alternate-name lookup: "Bangalore" resolves to the Bengaluru record (canonical name, not the alias)', () => {
    const hit = gaz.resolvePlace('Bangalore');
    assert.ok(hit);
    assert.equal(hit!.name, 'Bengaluru');
    assert.equal(hit!.countryName, 'India');
    assert.equal(hit!.ambiguousWith, undefined);
  });

  it('case and punctuation normalization: "  SYDNEY?? " resolves to the same record as "Sydney"', () => {
    const a = gaz.resolvePlace('Sydney');
    const b = gaz.resolvePlace('  SYDNEY?? ');
    assert.ok(a && b);
    assert.equal(a!.sourceId, b!.sourceId);
  });

  it('normalization also applies to alt-name lookups ("bangalore." lowercase + trailing period)', () => {
    const hit = gaz.resolvePlace('bangalore.');
    assert.ok(hit);
    assert.equal(hit!.name, 'Bengaluru');
  });

  it('an unknown place returns null (not a throw, not a guess)', () => {
    assert.equal(gaz.resolvePlace('Nonexistentville'), null);
    assert.equal(gaz.resolvePlace(''), null);
    assert.equal(gaz.resolvePlace('   '), null);
  });

  it('getVersion returns exactly the version the gazetteer was built with', () => {
    assert.equal(gaz.getVersion(), 'test-v1');
  });

  it('ensureReady resolves without throwing (index already built synchronously from records)', async () => {
    await assert.doesNotReject(gaz.ensureReady());
  });
});

describe('createGazetteerFromRecords — empty gazetteer (fail-soft contract)', () => {
  it('zero records: resolvePlace always returns null, never throws', () => {
    const empty = createGazetteerFromRecords([], 'empty-test');
    assert.doesNotThrow(() => empty.resolvePlace('Sydney'));
    assert.equal(empty.resolvePlace('Sydney'), null);
    assert.equal(empty.getVersion(), 'empty-test');
  });
});

describe('getDefaultGazetteer — before ensureReady() (fail-soft, network-free)', () => {
  it('resolvePlace returns null and getVersion reports "unloaded" before any load has been requested', () => {
    // Deliberately never calls ensureReady() here — resolvePlace()/getVersion()
    // alone never touch the network (only ensureReady() does, on-demand, and
    // only the compiler's compile() calls that). This asserts the pre-load
    // state degrades cleanly rather than throwing.
    const gaz = getDefaultGazetteer();
    assert.doesNotThrow(() => gaz.resolvePlace('Sydney'));
    assert.equal(gaz.resolvePlace('Sydney'), null);
    assert.equal(gaz.getVersion(), 'unloaded');
  });
});

// ── extractPlaceCandidates ──────────────────────────────────────────────────────

describe('extractPlaceCandidates', () => {
  it('extracts a capitalized place immediately after a locative trigger', () => {
    const c = extractPlaceCandidates('Which satellites are visible from Sydney right now?');
    assert.deepEqual(c, ['Sydney']);
  });

  it('grows multi-word candidates (1-3 words) while capitalization holds', () => {
    const c = extractPlaceCandidates('satellites visible over New York City today');
    assert.deepEqual(c, ['New', 'New York', 'New York City']);
  });

  it('stops growing a multi-word candidate at the first non-capitalized continuation word', () => {
    const c = extractPlaceCandidates('what can I see from Tokyo tonight');
    assert.deepEqual(c, ['Tokyo']);
  });

  it('does not extend past a stopword-led continuation but keeps the valid prefix (e.g. real "Las Vegas"-style names still work)', () => {
    const c = extractPlaceCandidates('what can we see near Las Vegas this week');
    assert.deepEqual(c, ['Las', 'Las Vegas']); // "this" stops growth after "Vegas"; "la/las" is NOT stopworded
  });

  it('FALSE-POSITIVE GUARD: an all-lowercase place mention never becomes a candidate ("over the pacific")', () => {
    const c = extractPlaceCandidates('which satellites pass over the pacific right now');
    assert.deepEqual(c, []);
  });

  it('FALSE-POSITIVE GUARD: a capitalized stopword right after the trigger is skipped ("from The station")', () => {
    const c = extractPlaceCandidates('visible from The station tonight');
    assert.deepEqual(c, []);
  });

  it('FALSE-POSITIVE GUARD: the candidate must IMMEDIATELY follow the trigger — an intervening word disqualifies it', () => {
    // "near" is immediately followed by "beautiful" (lowercase), not "Sydney" —
    // the guard must not reach past it to find the real place two words later.
    const c = extractPlaceCandidates('flying near beautiful Sydney tonight');
    assert.deepEqual(c, []);
  });

  it('no locative trigger at all → no candidates, even with capitalized words present', () => {
    const c = extractPlaceCandidates('Which satellites are slowing down?');
    assert.deepEqual(c, []);
  });

  it('a numeric token between the trigger and a later word blocks false adjacency (dropping "45" must not bridge "over" to "North")', () => {
    const c = extractPlaceCandidates('satellites over 45 North');
    assert.deepEqual(c, []);
  });

  it('deduplicates a repeated candidate mentioned via two different triggers', () => {
    const c = extractPlaceCandidates('visible from Sydney or above Sydney tonight');
    assert.deepEqual(c, ['Sydney']);
  });
});

// ── gazetteer-cache.ts — direct coverage of the new cache module ─────────────
// (mirrors tests/cache/swpc-cache.test.ts's temp-CACHE_DIR pattern; the file
// allowlist for this task permits only ONE new test file, so this exercises
// the cache module from here rather than a separate tests/cache/ file.)

describe('gazetteer-cache — read/write round trip', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gazetteer-cache-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readGazetteerCache returns null when no file exists yet (empty cache → null, no throw)', () => {
    assert.equal(readGazetteerCache(), null);
    assert.equal(isGazetteerCacheFresh(), false);
  });

  it('writeGazetteerCache then readGazetteerCache round-trips the records', () => {
    const records = parseGazetteerGeoJson(FIXTURE_GEOJSON);
    writeGazetteerCache(records);
    const cache = readGazetteerCache();
    assert.ok(cache);
    assert.equal(cache!.records.length, records.length);
    assert.equal(typeof cache!.version, 'string');
  });

  it('freshly written cache is fresh', () => {
    writeGazetteerCache(parseGazetteerGeoJson(FIXTURE_GEOJSON));
    assert.equal(isGazetteerCacheFresh(), true);
  });

  it('cache older than the 30-day TTL is reported stale but still reads back fine (stale-ok fallback)', () => {
    writeGazetteerCache(parseGazetteerGeoJson(FIXTURE_GEOJSON));
    const p = path.join(tmpDir, 'gazetteer-cache.json');
    const old = Date.now() - GAZETTEER_CACHE_TTL_MS - 1000;
    fs.utimesSync(p, old / 1000, old / 1000);
    assert.equal(isGazetteerCacheFresh(), false);
    assert.ok(readGazetteerCache()!.records.length > 0);
  });

  it('readGazetteerCache returns null and does not throw for a malformed file (wrong shape)', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gazetteer-cache.json'), '{"not":"the right shape"}', 'utf8');
    assert.doesNotThrow(() => readGazetteerCache());
    assert.equal(readGazetteerCache(), null);
  });

  it('readGazetteerCache returns null and does not throw for invalid JSON', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gazetteer-cache.json'), 'not json{{{', 'utf8');
    assert.doesNotThrow(() => readGazetteerCache());
    assert.equal(readGazetteerCache(), null);
  });

  it('write is atomic — no .tmp file left behind after a successful write', () => {
    writeGazetteerCache(parseGazetteerGeoJson(FIXTURE_GEOJSON));
    assert.equal(fs.existsSync(path.join(tmpDir, 'gazetteer-cache.json.tmp')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'gazetteer-cache.json')), true);
  });
});
