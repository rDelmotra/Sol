import { logger } from '../logger.js';
import { FileBlobStore } from './file-store.js';
import type { BlobStore } from './types.js';

// ============================================================
// Write-through mirror
//
// The local directory (CACHE_DIR) stays the working copy: every module keeps reading
// and writing plain files, synchronously, exactly as before. The mirror keeps a copy
// of those files in a remote BlobStore (an S3 bucket) so the attached volume stops
// being the only home of the data:
//
//   syncAtBoot()  reconcile local and remote once, before anything reads the files
//                 (newest side wins, nothing is ever deleted on either side)
//   flush()       upload what changed locally since the last upload
//   start()       flush on a timer; requestFlush() flushes soon (debounced)
//
// Three kinds of path:
//   files        one file each (the catalog, attempt logs, caches, alert state)
//   dirs         a folder of mutable state, compared file by file (dso/)
//   archiveDirs  a folder of daily snapshots: local files missing remotely are
//                uploaded, nothing is ever downloaded
//
// The remote object carries the local file's mtime, and a download restores it, so
// "how old is this cache" (the boot freshness check reads the mtime) is the same
// after a restart on a fresh disk as it was before.
//
// Single writer: only one process family writes these files at a time (one replica,
// or the leader). A restart picks the newest copy. Every failure is logged and
// swallowed; the mirror can never take the site down.
// ============================================================

export interface MirrorSpec {
  files: string[];
  dirs: string[];
  archiveDirs: string[];
}

export interface SyncReport {
  uploaded: string[];
  downloaded: string[];
  skipped: number;
  failed: number;
}

/** Two mtimes closer than this count as equal (S3 metadata is rounded, clocks differ a little). */
export const MTIME_TOLERANCE_MS = 2_000;

const FLUSH_DEBOUNCE_MS = 1_000;
const FAILURE_LOG_EVERY = 30;

function emptyReport(): SyncReport {
  return { uploaded: [], downloaded: [], skipped: 0, failed: 0 };
}

export class Mirror {
  private readonly local: FileBlobStore;
  /** key -> "size:mtime" of the last version known to be in the remote. */
  private readonly known = new Map<string, string>();
  private flushing: Promise<SyncReport> | null = null;
  private interval: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private failureStreak = 0;
  private archiveSync: Promise<void> = Promise.resolve();

  constructor(
    localRoot: string,
    private readonly remote: BlobStore,
    private readonly spec: MirrorSpec,
  ) {
    this.local = new FileBlobStore(localRoot);
  }

  private static sig(size: number, mtimeMs: number): string {
    return `${size}:${Math.round(mtimeMs)}`;
  }

  // ---------- boot ----------

  /**
   * Reconcile local and remote for files and dirs (awaited), then start the archive
   * backfill in the background (see waitForArchiveSync). Never throws.
   */
  async syncAtBoot(): Promise<SyncReport> {
    const report = emptyReport();
    try {
      const keys = new Set<string>(this.spec.files);
      for (const dir of this.spec.dirs) {
        for (const o of await this.local.list(`${dir}/`)) keys.add(o.key);
        for (const o of await this.remote.list(`${dir}/`)) keys.add(o.key);
      }
      for (const key of keys) await this.reconcile(key, report);
    } catch (err) {
      report.failed++;
      logger.warn(`Storage mirror: boot sync could not list files (${(err as Error).message}) — carrying on with the local copy`);
    }
    logger.info(
      `Storage mirror: boot sync done (${report.downloaded.length} downloaded, ${report.uploaded.length} uploaded, ` +
        `${report.skipped} already in sync, ${report.failed} failed)`,
    );
    this.archiveSync = this.backfillArchives().catch((err) =>
      logger.warn(`Storage mirror: archive backfill stopped (${(err as Error).message}); the next flush continues it`),
    );
    return report;
  }

  /** Resolves when the background archive backfill started by syncAtBoot has finished (tests, shutdown). */
  waitForArchiveSync(): Promise<void> {
    return this.archiveSync;
  }

  private async reconcile(key: string, report: SyncReport): Promise<void> {
    try {
      const [l, r] = await Promise.all([this.local.stat(key), this.remote.stat(key)]);
      if (!l && !r) return;
      if (l && !r) return void (await this.upload(key, l.size, l.mtimeMs, report));
      if (!l && r) return void (await this.download(key, r.mtimeMs, report));
      const diff = l!.mtimeMs - r!.mtimeMs;
      if (Math.abs(diff) <= MTIME_TOLERANCE_MS) {
        this.known.set(key, Mirror.sig(l!.size, l!.mtimeMs));
        report.skipped++;
      } else if (diff > 0) {
        await this.upload(key, l!.size, l!.mtimeMs, report);
      } else {
        await this.download(key, r!.mtimeMs, report);
      }
    } catch (err) {
      report.failed++;
      logger.warn(`Storage mirror: could not sync ${key} (${(err as Error).message})`);
    }
  }

  private async backfillArchives(): Promise<void> {
    const report = emptyReport();
    for (const dir of this.spec.archiveDirs) {
      for (const o of await this.local.list(`${dir}/`)) {
        try {
          const l = await this.local.stat(o.key);
          if (!l) continue;
          const r = await this.remote.stat(o.key);
          if (!r || (r.size !== l.size && l.mtimeMs - r.mtimeMs > MTIME_TOLERANCE_MS)) {
            await this.upload(o.key, l.size, l.mtimeMs, report);
          } else {
            this.known.set(o.key, Mirror.sig(l.size, l.mtimeMs));
            report.skipped++;
          }
        } catch (err) {
          report.failed++;
          logger.warn(`Storage mirror: could not back up ${o.key} (${(err as Error).message})`);
        }
      }
    }
    if (report.uploaded.length || report.failed) {
      logger.info(`Storage mirror: archive backfill done (${report.uploaded.length} uploaded, ${report.skipped} already there, ${report.failed} failed)`);
    }
  }

  // ---------- steady state ----------

  /** Upload every local file whose size or mtime differs from the last uploaded version. Never throws. */
  flush(): Promise<SyncReport> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<SyncReport> {
    const report = emptyReport();
    const keys = new Set<string>(this.spec.files);
    try {
      for (const dir of [...this.spec.dirs, ...this.spec.archiveDirs]) {
        for (const o of await this.local.list(`${dir}/`)) keys.add(o.key);
      }
    } catch (err) {
      report.failed++;
      logger.warn(`Storage mirror: flush could not list files (${(err as Error).message})`);
    }
    for (const key of keys) {
      try {
        const l = await this.local.stat(key);
        if (!l) continue;
        if (this.known.get(key) === Mirror.sig(l.size, l.mtimeMs)) {
          report.skipped++;
          continue;
        }
        await this.upload(key, l.size, l.mtimeMs, report);
      } catch (err) {
        report.failed++;
        this.noteFailure(`could not upload ${key} (${(err as Error).message})`);
      }
    }
    if (report.failed === 0) this.failureStreak = 0;
    return report;
  }

  private noteFailure(message: string): void {
    if (this.failureStreak % FAILURE_LOG_EVERY === 0) logger.warn(`Storage mirror: ${message}`);
    this.failureStreak++;
  }

  /** Flush on a timer. Safe to call twice. The timer never keeps the process alive. */
  start(intervalMs: number): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.flush(), intervalMs);
    this.interval.unref();
  }

  /** Flush soon (about a second), collapsing a burst of writes into one flush. */
  requestFlush(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.debounce.unref();
  }

  /** Stop the timers and do one last flush, giving up after `timeoutMs`. Never throws. */
  async close(timeoutMs: number): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
    this.interval = this.debounce = null;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn(`Storage mirror: final flush did not finish in ${timeoutMs} ms — giving up on it`);
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([this.flush().then(() => undefined), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------- transfers ----------

  private async upload(key: string, size: number, mtimeMs: number, report: SyncReport): Promise<void> {
    const data = await this.local.get(key);
    if (!data) return; // vanished between stat and read
    await this.remote.put(key, data, { mtimeMs });
    this.known.set(key, Mirror.sig(size, mtimeMs));
    report.uploaded.push(key);
  }

  private async download(key: string, mtimeMs: number, report: SyncReport): Promise<void> {
    const data = await this.remote.get(key);
    if (!data) return; // deleted remotely between stat and read
    await this.local.put(key, data, { mtimeMs });
    // Re-read what the filesystem actually stored: its mtime can differ from `mtimeMs` by a rounding step,
    // and a mismatch here would make the next flush upload the file again for nothing.
    const stored = await this.local.stat(key);
    this.known.set(key, Mirror.sig(stored?.size ?? data.length, stored?.mtimeMs ?? mtimeMs));
    report.downloaded.push(key);
  }
}
