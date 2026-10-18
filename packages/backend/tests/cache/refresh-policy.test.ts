// Refresh policy for the TLE cache: the daily cron must always refresh (unless the
// cache is very young), while boot keeps the 24 h TTL. Pure policy + a real temp dir.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  CACHE_TTL_MS,
  CRON_MIN_AGE_MS,
  cacheAgeMs,
  isCacheFresh,
  shouldSkipRefresh,
  writeCache,
} from '../../src/cache/file-cache.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('shouldSkipRefresh — pure policy', () => {
  it('cron refreshes when the cache is 23h59m old (the every-other-day bug)', () => {
    assert.equal(shouldSkipRefresh(23 * HOUR + 59 * MIN, 'cron'), false);
    assert.equal(shouldSkipRefresh(23 * HOUR + 59 * MIN + 48_000, 'cron'), false);
  });

  it('cron skips when the cache is 5 minutes old (double-trigger / restart loop)', () => {
    assert.equal(shouldSkipRefresh(5 * MIN, 'cron'), true);
  });

  it('cron boundary is CRON_MIN_AGE_MS', () => {
    assert.equal(shouldSkipRefresh(CRON_MIN_AGE_MS - 1, 'cron'), true);
    assert.equal(shouldSkipRefresh(CRON_MIN_AGE_MS, 'cron'), false);
  });

  it('boot skips when the cache is 10 h old', () => {
    assert.equal(shouldSkipRefresh(10 * HOUR, 'boot'), true);
  });

  it('boot refreshes once the cache is past the 24 h TTL', () => {
    assert.equal(shouldSkipRefresh(CACHE_TTL_MS - 1, 'boot'), true);
    assert.equal(shouldSkipRefresh(CACHE_TTL_MS, 'boot'), false);
    assert.equal(shouldSkipRefresh(30 * HOUR, 'boot'), false);
  });

  it('never skips when there is no cache', () => {
    assert.equal(shouldSkipRefresh(null, 'boot'), false);
    assert.equal(shouldSkipRefresh(null, 'cron'), false);
  });

  it('the cron guard is much shorter than the boot TTL', () => {
    assert.ok(CRON_MIN_AGE_MS <= 2 * HOUR);
    assert.ok(CRON_MIN_AGE_MS < CACHE_TTL_MS);
  });
});

describe('cacheAgeMs / isCacheFresh — real temp dir', () => {
  let tmpDir: string;
  let prevCacheDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-policy-test-'));
    prevCacheDir = process.env.CACHE_DIR;
    process.env.CACHE_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
    else process.env.CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function ageCacheFile(ageMs: number): void {
    const p = path.join(tmpDir, 'tle-cache.json');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
  }

  it('returns null with no cache file', () => {
    assert.equal(cacheAgeMs(), null);
    assert.equal(isCacheFresh(), false);
  });

  it('measures the age from the file mtime and honours an injected clock', () => {
    writeCache([]);
    ageCacheFile(23 * HOUR + 59 * MIN);
    const age = cacheAgeMs()!;
    assert.ok(age >= 23 * HOUR + 59 * MIN && age < 24 * HOUR);
    // injected "now" one hour later
    const later = cacheAgeMs(Date.now() + HOUR)!;
    assert.ok(later > 24 * HOUR);
  });

  it('a 23h59m cache is boot-fresh but the cron still refreshes', () => {
    writeCache([]);
    ageCacheFile(23 * HOUR + 59 * MIN);
    assert.equal(isCacheFresh(), true);
    assert.equal(shouldSkipRefresh(cacheAgeMs(), 'boot'), true);
    assert.equal(shouldSkipRefresh(cacheAgeMs(), 'cron'), false);
  });

  it('a 5 minute cache makes the cron skip', () => {
    writeCache([]);
    ageCacheFile(5 * MIN);
    assert.equal(shouldSkipRefresh(cacheAgeMs(), 'cron'), true);
  });
});
