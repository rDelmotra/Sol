import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './paths.js';
import { logger } from './logger.js';

// ============================================================
// Disk usage visibility for the data volume (CACHE_DIR, 500 MB on Railway).
//
// Read-only: this module only measures and reports. It never deletes, prunes
// or rotates anything.
//
// Percent follows `df`: used / (used + space available to this process), so the
// number matches what the owner sees in `df` and the Railway volume graph.
// ============================================================

export const DISK_WARN_PERCENT = 75;
export const DISK_CRITICAL_PERCENT = 90;

export type DiskLevel = 'ok' | 'warn' | 'critical';

export interface DiskUsage {
  usedBytes: number;
  totalBytes: number;
  /** 0-100, one decimal. */
  percent: number;
  level: DiskLevel;
}

/** The fields of fs.StatFs we use (so tests can pass plain numbers). */
export interface StatfsLike {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

/** Pure: map a percent-used to a level. >=90 critical, >=75 warn, else ok. */
export function classifyDiskPercent(
  percent: number,
  warnAt: number = DISK_WARN_PERCENT,
  criticalAt: number = DISK_CRITICAL_PERCENT,
): DiskLevel {
  if (percent >= criticalAt) return 'critical';
  if (percent >= warnAt) return 'warn';
  return 'ok';
}

/** Pure: turn raw statfs numbers into used / total / percent / level. */
export function computeDiskUsage(s: StatfsLike): DiskUsage {
  const usedBytes = Math.max(0, s.blocks - s.bfree) * s.bsize;
  const totalBytes = usedBytes + Math.max(0, s.bavail) * s.bsize;
  const raw = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  const percent = Math.round(raw * 10) / 10;
  return { usedBytes, totalBytes, percent, level: classifyDiskPercent(raw) };
}

/** One human line, e.g. "disk 123.4 MB / 500.0 MB (24.7%)". */
export function formatDiskUsage(u: DiskUsage): string {
  const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
  return `disk ${mb(u.usedBytes)} / ${mb(u.totalBytes)} (${u.percent}%)`;
}

export type StatfsFn = (p: string) => Promise<StatfsLike>;

/**
 * Measure the filesystem that holds `dir` (default CACHE_DIR). If the directory
 * does not exist yet, the nearest existing parent is measured. Returns null if
 * the platform cannot tell us; never throws.
 */
export async function readDiskUsage(
  dir: string = cacheDir(),
  statfs: StatfsFn = (p) => fs.promises.statfs(p),
): Promise<DiskUsage | null> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      return computeDiskUsage(await statfs(current));
    } catch (err) {
      const parent = path.dirname(current);
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing || parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Measure and log. INFO normally, WARN at >= 75%, ERROR at >= 90%.
 * Never throws, so it is safe to call from boot and from write paths.
 */
export async function logDiskUsage(context: string, dir?: string): Promise<DiskUsage | null> {
  try {
    const u = await readDiskUsage(dir);
    if (!u) {
      logger.warn(`Disk usage (${context}): unavailable`);
      return null;
    }
    const line = `Disk usage (${context}): ${formatDiskUsage(u)}`;
    if (u.level === 'critical') logger.error(`${line} — CRITICAL, at or above ${DISK_CRITICAL_PERCENT}%`);
    else if (u.level === 'warn') logger.warn(`${line} — at or above ${DISK_WARN_PERCENT}%`);
    else logger.info(line);
    return u;
  } catch (err) {
    logger.warn(`Disk usage (${context}) failed: ${(err as Error).message}`);
    return null;
  }
}
