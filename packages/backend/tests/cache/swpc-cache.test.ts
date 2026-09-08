// swpc-cache.ts — file-based cache for NOAA SWPC daily indices.
// Mirrors the read/write/freshness contract of file-cache.ts's visual-cache
// helpers, exercised against a real temp directory (CACHE_DIR override).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  readSwpcCache,
  writeSwpcCache,
  isSwpcCacheFresh,
  SWPC_CACHE_TTL_MS,
} from '../../src/cache/swpc-cache.js';
import type { SwpcDailyIndex } from '../../src/services/swpc.js';

const RECORDS: SwpcDailyIndex[] = [
  { date: '2026-09-05', apIndex: 5, kpIndex: 1.33, f107: 108 },
  { date: '2026-09-06', apIndex: 4, kpIndex: 1.24, f107: 110 },
];

let tmpDir: string;
let prevCacheDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swpc-cache-test-'));
  prevCacheDir = process.env.CACHE_DIR;
  process.env.CACHE_DIR = tmpDir;
});

afterEach(() => {
  if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
  else process.env.CACHE_DIR = prevCacheDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('swpc-cache — read/write round trip', () => {
  it('readSwpcCache returns null when no file exists yet', () => {
    assert.equal(readSwpcCache(), null);
    assert.equal(isSwpcCacheFresh(), false);
  });

  it('writeSwpcCache then readSwpcCache round-trips the records', () => {
    writeSwpcCache(RECORDS);
    const cache = readSwpcCache();
    assert.ok(cache);
    assert.deepEqual(cache!.records, RECORDS);
    assert.equal(typeof cache!.version, 'string');
  });

  it('freshly written cache is fresh', () => {
    writeSwpcCache(RECORDS);
    assert.equal(isSwpcCacheFresh(), true);
  });

  it('cache older than the TTL is reported stale', () => {
    writeSwpcCache(RECORDS);
    const p = path.join(tmpDir, 'swpc-cache.json');
    const old = Date.now() - SWPC_CACHE_TTL_MS - 1000;
    fs.utimesSync(p, old / 1000, old / 1000);
    assert.equal(isSwpcCacheFresh(), false);
    // Stale-but-present cache still reads back fine (the "fetch failed but
    // stale cache exists" graceful-degrade path the provider relies on).
    assert.deepEqual(readSwpcCache()!.records, RECORDS);
  });

  it('readSwpcCache returns null and does not throw for a malformed file', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'swpc-cache.json'), '{"not":"the right shape"}', 'utf8');
    assert.equal(readSwpcCache(), null);
  });

  it('readSwpcCache returns null and does not throw for invalid JSON', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'swpc-cache.json'), 'not json{{{', 'utf8');
    assert.equal(readSwpcCache(), null);
  });

  it('write is atomic — no .tmp file left behind after a successful write', () => {
    writeSwpcCache(RECORDS);
    assert.equal(fs.existsSync(path.join(tmpDir, 'swpc-cache.json.tmp')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'swpc-cache.json')), true);
  });
});
