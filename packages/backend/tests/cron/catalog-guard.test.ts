// The catalog size guard: an empty or far-too-small answer from Space-Track or
// CelesTrak must never replace the good cache. assessCatalog is pure; the cycle
// tests use fake fetchers, a real temp cache dir and an injected clock.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { cancelUpdateRetry, runUpdateCycle, type UpdateCycleDeps } from '../../src/cron/tle-updater.js';
import { assessCatalog, readCache, readVersion, writeCache } from '../../src/cache/file-cache.js';
import { readAttemptState, stateOnSuccess } from '../../src/cache/attempt-log.js';
import { catalogMinRatio } from '../../src/utils/config.js';
import { celesTrakGp, fakeCatalog, spaceTrackGp } from './gp-fixtures.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.now();

describe('assessCatalog — pure policy', () => {
  it('refuses an empty catalog, with or without a cache', () => {
    assert.equal(assessCatalog(0, null).ok, false);
    assert.equal(assessCatalog(0, 32_000).ok, false);
    assert.equal(assessCatalog(0, 0).ok, false);
    assert.match(assessCatalog(0, 32_000).reason, /0 objects/);
  });

  it('refuses a count that is not a number', () => {
    assert.equal(assessCatalog(Number.NaN, 100).ok, false);
  });

  it('refuses 49% of the cache and says the numbers', () => {
    const v = assessCatalog(49, 100);
    assert.equal(v.ok, false);
    assert.match(v.reason, /49 objects/);
    assert.match(v.reason, /49\.0%/);
    assert.match(v.reason, /100 cached/);
  });

  it('accepts 50% and 51% of the cache', () => {
    assert.equal(assessCatalog(50, 100).ok, true);
    assert.equal(assessCatalog(51, 100).ok, true);
  });

  it('accepts growth', () => {
    assert.equal(assessCatalog(40_000, 32_000).ok, true);
  });

  it('without a cache accepts any non-empty catalog, even one object', () => {
    assert.equal(assessCatalog(1, null).ok, true);
    assert.equal(assessCatalog(7, null).ok, true);
  });

  it('an empty cache counts as no cache', () => {
    assert.equal(assessCatalog(3, 0).ok, true);
  });

  it('a lower minimum ratio loosens the size check but never the empty check', () => {
    assert.equal(assessCatalog(30, 100, 0.2).ok, true);
    assert.equal(assessCatalog(10, 100, 0.2).ok, false);
    assert.equal(assessCatalog(1, 100, 0).ok, true);
    assert.equal(assessCatalog(0, 100, 0).ok, false);
  });
});

describe('catalogMinRatio — CATALOG_MIN_RATIO', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CATALOG_MIN_RATIO;
    delete process.env.CATALOG_MIN_RATIO;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CATALOG_MIN_RATIO;
    else process.env.CATALOG_MIN_RATIO = prev;
  });

  it('defaults to 0.5', () => {
    assert.equal(catalogMinRatio(), 0.5);
    process.env.CATALOG_MIN_RATIO = '  ';
    assert.equal(catalogMinRatio(), 0.5);
  });

  it('reads a number from 0 to 1 and clamps the rest', () => {
    process.env.CATALOG_MIN_RATIO = '0.2';
    assert.equal(catalogMinRatio(), 0.2);
    process.env.CATALOG_MIN_RATIO = '0';
    assert.equal(catalogMinRatio(), 0);
    process.env.CATALOG_MIN_RATIO = '7';
    assert.equal(catalogMinRatio(), 1);
    process.env.CATALOG_MIN_RATIO = '-3';
    assert.equal(catalogMinRatio(), 0);
  });

  it('a value that is not a number falls back to 0.5', () => {
    process.env.CATALOG_MIN_RATIO = 'half';
    assert.equal(catalogMinRatio(), 0.5);
  });
});

describe('runUpdateCycle — implausible catalogs are refused', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;
  let prevRatio: string | undefined;
  let lines: string[];
  let clock: number;
  let stCalls: number;
  let ctCalls: number;

  type Answer = 'throw' | number;

  /** A fake source: a number = that many records, 'throw' = the fetch fails. */
  function deps(
    st: Answer,
    ct: Answer,
    over: Partial<UpdateCycleDeps> = {},
  ): Partial<UpdateCycleDeps> {
    return {
      spaceTrackConfigured: () => true,
      now: () => clock,
      fetchSpaceTrack: async () => {
        stCalls++;
        if (st === 'throw') throw new Error('Space-Track login rejected (HTTP 500)');
        return { gp: spaceTrackGp(st) };
      },
      fetchCelesTrak: async () => {
        ctCalls++;
        if (ct === 'throw') throw new Error('CelesTrak fetch failed after 3 attempts');
        return celesTrakGp(ct);
      },
      ...over,
    };
  }

  const cachePath = () => path.join(tmpDir, 'tle-cache.json');
  const versionPath = () => path.join(tmpDir, 'version.json');

  /** A cached catalog of n objects, old enough that a boot cycle really fetches. */
  function seedCache(n: number): { cache: string; version: string } {
    writeCache(fakeCatalog(n));
    const old = new Date(T0 - 30 * HOUR);
    fs.utimesSync(cachePath(), old, old);
    lines.length = 0; // the seed's own "Cache written" line is not part of the cycle
    return {
      cache: fs.readFileSync(cachePath(), 'utf8'),
      version: fs.readFileSync(versionPath(), 'utf8'),
    };
  }

  function cacheCount(): number {
    return readCache()?.length ?? -1;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-guard-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    prevRatio = process.env.CATALOG_MIN_RATIO;
    process.env.CACHE_DIR = tmpDir;
    delete process.env.CATALOG_MIN_RATIO;
    lines = [];
    clock = T0;
    stCalls = 0;
    ctCalls = 0;
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });

  afterEach(() => {
    cancelUpdateRetry(); // no retry timer outlives its test
    mock.restoreAll();
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    if (prevRatio === undefined) delete process.env.CATALOG_MIN_RATIO;
    else process.env.CATALOG_MIN_RATIO = prevRatio;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('normal day: a full answer replaces the cache and counts as a success', async () => {
    seedCache(100);
    await runUpdateCycle('boot', deps(100, 'throw'));
    assert.equal(stCalls, 1);
    assert.equal(ctCalls, 0);
    assert.equal(cacheCount(), 100);
    assert.equal(readVersion()?.count, 100);
    assert.deepEqual(readAttemptState(), stateOnSuccess(T0));
    assert.ok(lines.some((l) => l.includes('TLE update complete: 100 objects from space-track')));
  });

  it('Space-Track answers 200 [] and CelesTrak is down: the old cache and version.json stay byte for byte', async () => {
    const before = seedCache(100);
    await runUpdateCycle('boot', deps(0, 'throw'));
    assert.equal(stCalls, 1);
    assert.equal(ctCalls, 1);
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), before.cache);
    assert.equal(fs.readFileSync(versionPath(), 'utf8'), before.version);
    assert.equal(fs.existsSync(cachePath() + '.tmp'), false);

    assert.ok(lines.some((l) => l.includes('ERROR') && l.includes('Space-Track catalog refused') && l.includes('0 records fetched')));
    assert.ok(lines.some((l) => l.includes('WARN') && l.includes('continuing to serve stale cache (100 objects)')));
    // refused means: nothing written, no warm-up, no completion line
    assert.equal(lines.some((l) => l.includes('Cache written')), false);
    assert.equal(lines.some((l) => l.includes('TLE update complete')), false);
  });

  it('a refused Space-Track answer is recorded as a failure, so the backoff applies', async () => {
    seedCache(100);
    await runUpdateCycle('boot', deps(0, 'throw'));
    const state = readAttemptState();
    assert.equal(state?.lastOutcome, 'failure');
    assert.equal(state?.consecutiveFailures, 1);

    // a restart a minute later does not log in again
    clock = T0 + MIN;
    await runUpdateCycle('boot', deps(100, 'throw'));
    assert.equal(stCalls, 1, 'second login held back');
    assert.equal(cacheCount(), 100, 'still the old cache');

    // after the 15 minute wait the next login is allowed and a good answer wins
    clock = T0 + 15 * MIN;
    await runUpdateCycle('boot', deps(100, 'throw'));
    assert.equal(stCalls, 2);
    assert.deepEqual(readAttemptState(), stateOnSuccess(T0 + 15 * MIN));
  });

  it('empty from Space-Track, good from CelesTrak: CelesTrak fills the cache and Space-Track stays a failure', async () => {
    seedCache(100);
    await runUpdateCycle('boot', deps(0, 90));
    assert.equal(stCalls, 1);
    assert.equal(ctCalls, 1);
    assert.equal(cacheCount(), 90);
    assert.ok(lines.some((l) => l.includes('TLE update complete: 90 objects from celestrak')));
    assert.equal(readAttemptState()?.lastOutcome, 'failure');
  });

  it('half answer (page 1 came, page 2 was cut off): 40 of 100 is refused, the cache stays', async () => {
    const before = seedCache(100);
    // the fetcher "succeeds" with only the first part of the catalog
    await runUpdateCycle('boot', deps(40, 'throw'));
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), before.cache);
    assert.equal(readVersion()?.count, 100);
    assert.ok(lines.some((l) => l.includes('Space-Track catalog refused') && l.includes('40.0%')));
    assert.equal(readAttemptState()?.lastOutcome, 'failure');
  });

  it('49% is refused, 51% is accepted', async () => {
    const before = seedCache(100);
    await runUpdateCycle('boot', deps(49, 'throw'));
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), before.cache);

    // the refused try is now backing off; clear the log so this run really fetches
    fs.rmSync(path.join(tmpDir, 'spacetrack-attempts.json'));
    await runUpdateCycle('boot', deps(51, 'throw'));
    assert.equal(cacheCount(), 51);
  });

  it('CelesTrak also answers too little: the cache is kept and nothing is written', async () => {
    const before = seedCache(100);
    await runUpdateCycle('boot', deps('throw', 30));
    assert.equal(stCalls, 1);
    assert.equal(ctCalls, 1);
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), before.cache);
    assert.equal(fs.readFileSync(versionPath(), 'utf8'), before.version);
    assert.ok(lines.some((l) => l.includes('ERROR') && l.includes('CelesTrak catalog refused') && l.includes('30.0%')));
    assert.ok(lines.some((l) => l.includes('continuing to serve stale cache (100 objects)')));
    assert.equal(lines.some((l) => l.includes('Cache written')), false);
  });

  it('both sources refused: the cache is kept', async () => {
    const before = seedCache(100);
    await runUpdateCycle('boot', deps(0, 0));
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), before.cache);
    assert.equal(readAttemptState()?.lastOutcome, 'failure');
  });

  it('fresh volume: no cache accepts a small answer', async () => {
    assert.equal(fs.existsSync(cachePath()), false);
    await runUpdateCycle('boot', deps(3, 'throw'));
    assert.equal(cacheCount(), 3);
    assert.deepEqual(readAttemptState(), stateOnSuccess(T0));
  });

  it('fresh volume, only CelesTrak (no Space-Track credentials): a small answer is accepted', async () => {
    await runUpdateCycle('boot', deps('throw', 5, { spaceTrackConfigured: () => false }));
    assert.equal(cacheCount(), 5);
    assert.equal(fs.existsSync(path.join(tmpDir, 'spacetrack-attempts.json')), false);
  });

  it('fresh volume: an empty answer from both sources writes nothing', async () => {
    await runUpdateCycle('boot', deps(0, 0));
    assert.equal(fs.existsSync(cachePath()), false);
    assert.equal(fs.existsSync(versionPath()), false);
    assert.ok(lines.some((l) => l.includes('All sources failed and no cache exists')));
  });

  it('an unreadable cache counts as no cache, so a small answer can repair it', async () => {
    fs.writeFileSync(cachePath(), 'not json{{', 'utf8');
    const old = new Date(T0 - 30 * HOUR);
    fs.utimesSync(cachePath(), old, old);
    await runUpdateCycle('boot', deps(4, 'throw'));
    assert.equal(cacheCount(), 4);
  });

  it('CATALOG_MIN_RATIO lowers the bar: 30% passes at 0.2', async () => {
    seedCache(100);
    process.env.CATALOG_MIN_RATIO = '0.2';
    await runUpdateCycle('boot', deps(30, 'throw'));
    assert.equal(cacheCount(), 30);
  });

  it('CATALOG_MIN_RATIO=0 still refuses an empty answer', async () => {
    const before = seedCache(100);
    process.env.CATALOG_MIN_RATIO = '0';
    await runUpdateCycle('boot', deps(0, 0));
    assert.equal(fs.readFileSync(cachePath(), 'utf8'), before.cache);
  });
});
