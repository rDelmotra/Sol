import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { requestMirrorFlush } from '../utils/storage/mirror-runtime.js';

// ============================================================
// Tiny JSON state files that live next to the cache (the Space-Track and the
// CelesTrak attempt logs). Shared so both follow the same never-blocks-boot rules:
//   - missing file -> null, silently
//   - unreadable, not JSON, or the wrong shape -> null with one WARN
//   - write = temp file + atomic rename; a failure is a WARN, never a throw
// `label` names the file in the log lines, for example 'Space-Track attempt log'.
// ============================================================

/** Read and validate. `parse` returns null for a wrong shape. Never throws. */
export function readStateFile<T>(filePath: string, label: string, parse: (raw: unknown) => T | null): T | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`${label} unreadable (${(err as Error).message}) — treating as empty`);
    }
    return null;
  }

  try {
    const parsed = parse(JSON.parse(text));
    if (!parsed) {
      logger.warn(`${label} has an invalid shape — treating as empty`);
    }
    return parsed;
  } catch {
    logger.warn(`${label} is not valid JSON — treating as empty`);
    return null;
  }
}

/** Atomic write: temp file in the same directory, then rename. Failure -> WARN, boot goes on. */
export function writeStateFile(filePath: string, label: string, state: unknown): void {
  const tmp = filePath + '.tmp';
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, filePath);
    requestMirrorFlush(); // no-op unless the bucket mirror is running
  } catch (err) {
    logger.warn(`${label} could not be written (${(err as Error).message}) — continuing without it`);
  }
}
