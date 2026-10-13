// disk-usage — threshold logic and statfs math are pure; the reader takes an injected statfs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DISK_CRITICAL_PERCENT,
  DISK_WARN_PERCENT,
  classifyDiskPercent,
  computeDiskUsage,
  formatDiskUsage,
  readDiskUsage,
} from '../../src/utils/disk-usage.js';

describe('classifyDiskPercent', () => {
  it('thresholds are 75 and 90', () => {
    assert.equal(DISK_WARN_PERCENT, 75);
    assert.equal(DISK_CRITICAL_PERCENT, 90);
  });

  it('below 75 is ok', () => {
    assert.equal(classifyDiskPercent(0), 'ok');
    assert.equal(classifyDiskPercent(50), 'ok');
    assert.equal(classifyDiskPercent(74.9), 'ok');
  });

  it('75 up to 90 is warn', () => {
    assert.equal(classifyDiskPercent(75), 'warn');
    assert.equal(classifyDiskPercent(89.9), 'warn');
  });

  it('90 and above is critical', () => {
    assert.equal(classifyDiskPercent(90), 'critical');
    assert.equal(classifyDiskPercent(100), 'critical');
  });

  it('accepts custom thresholds', () => {
    assert.equal(classifyDiskPercent(60, 50, 80), 'warn');
    assert.equal(classifyDiskPercent(80, 50, 80), 'critical');
  });
});

describe('computeDiskUsage', () => {
  // 500 MB volume of 4 KiB blocks, no reserved blocks (bfree == bavail).
  const bsize = 4096;
  const blocks = (500 * 1_048_576) / bsize;

  it('computes used / total / percent for a quarter-full disk', () => {
    const free = blocks * 0.75;
    const u = computeDiskUsage({ bsize, blocks, bfree: free, bavail: free });
    assert.equal(u.totalBytes, 500 * 1_048_576);
    assert.equal(u.usedBytes, 125 * 1_048_576);
    assert.equal(u.percent, 25);
    assert.equal(u.level, 'ok');
  });

  it('flags warn at 80% and critical at 95%', () => {
    const at = (usedFrac: number) => {
      const free = blocks * (1 - usedFrac);
      return computeDiskUsage({ bsize, blocks, bfree: free, bavail: free });
    };
    assert.equal(at(0.8).level, 'warn');
    assert.equal(at(0.95).level, 'critical');
  });

  it('percent follows df: reserved blocks count as used for the non-root user', () => {
    // 100 blocks, 10 free, but only 5 available to us (5 reserved) -> used 90, total 95.
    const u = computeDiskUsage({ bsize: 1, blocks: 100, bfree: 10, bavail: 5 });
    assert.equal(u.usedBytes, 90);
    assert.equal(u.totalBytes, 95);
    assert.equal(u.percent, 94.7);
    assert.equal(u.level, 'critical');
  });

  it('an empty/zero filesystem reports 0%', () => {
    const u = computeDiskUsage({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 });
    assert.equal(u.percent, 0);
    assert.equal(u.level, 'ok');
  });
});

describe('formatDiskUsage', () => {
  it('prints MB and percent', () => {
    const line = formatDiskUsage({
      usedBytes: 125 * 1_048_576,
      totalBytes: 500 * 1_048_576,
      percent: 25,
      level: 'ok',
    });
    assert.equal(line, 'disk 125.0 MB / 500.0 MB (25%)');
  });
});

describe('readDiskUsage', () => {
  const stats = { bsize: 4096, blocks: 1000, bfree: 400, bavail: 400 };

  it('uses the statfs of the given directory', async () => {
    const seen: string[] = [];
    const u = await readDiskUsage('/data/x', async (p) => {
      seen.push(p);
      return stats;
    });
    assert.deepEqual(seen, ['/data/x']);
    assert.equal(u?.percent, 60);
  });

  it('falls back to the nearest existing parent when the dir is missing', async () => {
    const seen: string[] = [];
    const u = await readDiskUsage('/data/a/b', async (p) => {
      seen.push(p);
      if (p !== '/data') {
        const err = new Error('nope') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return stats;
    });
    assert.deepEqual(seen, ['/data/a/b', '/data/a', '/data']);
    assert.equal(u?.percent, 60);
  });

  it('returns null (never throws) on other errors', async () => {
    const u = await readDiskUsage('/data', async () => {
      throw new Error('statfs unsupported');
    });
    assert.equal(u, null);
  });

  it('returns null when even the root is missing', async () => {
    const u = await readDiskUsage('/data', async () => {
      const err = new Error('nope') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    assert.equal(u, null);
  });
});
