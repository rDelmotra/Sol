import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  BACKEND_ROOT,
  cacheDir,
  dsoCacheRoot,
  historyArchiveDir,
  backendDataDir,
  enrichmentDataDir,
  frontendDistDir,
} from '../../src/utils/paths.ts';

describe('utils/paths', () => {
  const saved = { c: process.env.CACHE_DIR, h: process.env.HISTORY_ARCHIVE_DIR };
  beforeEach(() => {
    delete process.env.CACHE_DIR;
    delete process.env.HISTORY_ARCHIVE_DIR;
  });
  afterEach(() => {
    if (saved.c === undefined) delete process.env.CACHE_DIR; else process.env.CACHE_DIR = saved.c;
    if (saved.h === undefined) delete process.env.HISTORY_ARCHIVE_DIR; else process.env.HISTORY_ARCHIVE_DIR = saved.h;
  });

  it('BACKEND_ROOT is packages/backend', () => {
    assert.equal(path.basename(BACKEND_ROOT), 'backend');
    assert.equal(path.basename(path.dirname(BACKEND_ROOT)), 'packages');
  });

  it('defaults resolve under BACKEND_ROOT', () => {
    assert.equal(cacheDir(), path.join(BACKEND_ROOT, 'data'));
    assert.equal(dsoCacheRoot(), path.join(BACKEND_ROOT, 'data', 'dso'));
    assert.equal(historyArchiveDir(), path.join(BACKEND_ROOT, 'data', 'history', 'raw'));
    assert.equal(backendDataDir(), path.join(BACKEND_ROOT, 'data'));
    assert.equal(enrichmentDataDir(), path.join(BACKEND_ROOT, 'enrichment-data'));
    assert.equal(frontendDistDir(), path.resolve(BACKEND_ROOT, '..', 'frontend', 'dist'));
  });

  it('CACHE_DIR is read at call time and changes between calls', () => {
    process.env.CACHE_DIR = '/tmp/ow-a';
    assert.equal(cacheDir(), path.resolve('/tmp/ow-a'));
    assert.equal(dsoCacheRoot(), path.resolve('/tmp/ow-a', 'dso'));
    assert.equal(historyArchiveDir(), path.join(path.resolve('/tmp/ow-a'), 'history', 'raw'));
    process.env.CACHE_DIR = '/tmp/ow-b';
    assert.equal(cacheDir(), path.resolve('/tmp/ow-b'));
    assert.equal(dsoCacheRoot(), path.resolve('/tmp/ow-b', 'dso'));
  });

  it('backendDataDir ignores CACHE_DIR', () => {
    process.env.CACHE_DIR = '/tmp/ow-a';
    assert.equal(backendDataDir(), path.join(BACKEND_ROOT, 'data'));
  });

  it('HISTORY_ARCHIVE_DIR wins over CACHE_DIR', () => {
    process.env.CACHE_DIR = '/tmp/ow-a';
    process.env.HISTORY_ARCHIVE_DIR = '/tmp/ow-h';
    assert.equal(historyArchiveDir(), path.resolve('/tmp/ow-h'));
  });
});
