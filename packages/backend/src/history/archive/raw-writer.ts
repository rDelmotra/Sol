import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { historyArchiveDir } from '../../utils/paths.js';
import type { RawGpRecord } from '../ingest/sink.js';
import { logger } from '../../utils/logger.js';

// ============================================================
// Raw GP archive — the "source of truth" layer.
//
// Each fetch cycle's raw provider records are written verbatim (gzipped JSON,
// one file per UTC fetch-day) so the serving DB can always be rebuilt/replayed
// and the original fields (beyond what EnrichedTLEObject keeps) are preserved.
//
// Phase 1 writes the CURRENT GP once a day → tiny. Phase 2's bulk gp_history
// acquire stage will write into the same directory; it owns its own (likely CSV)
// chunk format for the bulk pull — what's shared and load-bearing is the
// idempotent SINK, not this archive's on-disk encoding.
//
// On an ephemeral filesystem (e.g. a fresh container per deploy) this archive is
// transient; the serving DB persists independently. Point HISTORY_ARCHIVE_DIR at
// a mounted volume to make the archive durable.
// ============================================================

function archiveDir(): string {
  return historyArchiveDir();
}

/** UTC fetch-day bucket, e.g. '2026-06-25'. */
function fetchDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Write today's raw GP snapshot as `<dir>/YYYY-MM-DD.json.gz` (atomic via tmp +
 * rename; latest write in a day wins, mirroring the daily-downsample). Throws on
 * failure so the caller can log non-fatally.
 */
export async function writeRawArchive(records: RawGpRecord[], source: string): Promise<void> {
  const dir = archiveDir();
  fs.mkdirSync(dir, { recursive: true });

  const day = fetchDay();
  const finalPath = path.join(dir, `${day}.json.gz`);
  const tmpPath = `${finalPath}.tmp`;

  const envelope = JSON.stringify({ day, source, fetchedAt: new Date().toISOString(), records });
  const gz = zlib.gzipSync(Buffer.from(envelope, 'utf8'), { level: 9 });

  await fs.promises.writeFile(tmpPath, gz);
  await fs.promises.rename(tmpPath, finalPath);

  logger.info(
    `History raw archive written: ${path.basename(finalPath)} ` +
      `(${records.length} records, ${(gz.length / 1_048_576).toFixed(2)} MB gz)`,
  );
}
