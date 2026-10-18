import { Router, type Request, type Response } from 'express';
import {
  getDsoRegistryEntry,
  getEnabledDsoRegistryEntries,
} from '../dso/registry/index.js';
import {
  readCurrentDsoSnapshot,
  readDsoCatalog,
  readDsoManifest,
} from '../dso/snapshot/index.js';
import { readDsoEndedState } from '../dso/worker/ended-state.js';
import type { DsoManifest } from '@orbitwatch/contracts';
import { logger } from '../utils/logger.js';

const router = Router();

/** Longest a DSO file read may take before the request gives up on it (hung or dead mount). */
export const DSO_READ_TIMEOUT_MS = 2_000;

/**
 * Bound a DSO read. The DSO side must never slow or break the rest of the API, so
 * every read on a request path goes through here: it rejects after `timeoutMs`
 * and the timer never keeps the process alive.
 */
export function withDsoTimeout<T>(work: Promise<T>, timeoutMs: number = DSO_READ_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DSO read timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** A manifest read from disk, or null when absent. Throws when unreadable, corrupt or the wrong shape. */
async function readManifestChecked(): Promise<DsoManifest | null> {
  const manifest = await withDsoTimeout(readDsoManifest());
  if (manifest === null) return null;
  if (typeof manifest !== 'object' || !manifest.objects || typeof manifest.objects !== 'object') {
    throw new Error('DSO manifest has an invalid shape');
  }
  return manifest;
}

/**
 * Wrap a DSO route so nothing it does can escape: a throw or rejection (corrupt JSON,
 * unreadable directory, timeout) becomes a fast 503 JSON, never an unhandled rejection.
 */
function safeRoute(
  name: string,
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.warn(`${name}: DSO data unavailable (${(err as Error)?.message ?? String(err)})`);
      if (!res.headersSent) {
        res.status(503).json({ error: 'DSO data unavailable. Try again shortly.' });
      }
    }
  };
}

function sendNotModifiedIfMatched(req: Request, res: Response, etag: string): boolean {
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }

  return false;
}

router.get('/catalog', safeRoute('GET /api/dso/catalog', async (req, res) => {
  const catalog = await withDsoTimeout(readDsoCatalog());
  if (!catalog) {
    logger.warn('GET /api/dso/catalog: no catalog available yet');
    res.status(503).json({ error: 'DSO catalog not yet available. Try again shortly.' });
    return;
  }

  const etag = `"${catalog.catalogVersion}"`;
  if (sendNotModifiedIfMatched(req, res, etag)) {
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('ETag', etag);
  res.json(catalog);
}));

router.get('/manifest', safeRoute('GET /api/dso/manifest', async (req, res) => {
  const manifest = await readManifestChecked();
  if (!manifest) {
    logger.warn('GET /api/dso/manifest: no manifest available yet');
    res.status(503).json({ error: 'DSO manifest not yet available. Try again shortly.' });
    return;
  }

  const etag = `"${manifest.generatedAt}"`;
  if (sendNotModifiedIfMatched(req, res, etag)) {
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('ETag', etag);
  res.json(manifest);
}));

router.get('/ephemeris/:dsoId', safeRoute('GET /api/dso/ephemeris', async (req, res) => {
  const dsoId = req.params.dsoId;
  const entry = getDsoRegistryEntry(dsoId);

  if (!entry || !entry.enabled) {
    res.status(404).json({ error: 'Unknown or disabled DSO.' });
    return;
  }

  const manifest = await readManifestChecked();
  const status = manifest?.objects[entry.dsoId];
  if (!manifest || !status?.currentSnapshotVersion) {
    logger.warn(`GET /api/dso/ephemeris/${entry.dsoId}: no published snapshot available yet`);
    res.status(503).json({ error: 'DSO ephemeris not yet available. Try again shortly.' });
    return;
  }

  const etag = `"${status.currentSnapshotVersion}"`;
  if (sendNotModifiedIfMatched(req, res, etag)) {
    return;
  }

  const snapshot = await withDsoTimeout(readCurrentDsoSnapshot(entry.dsoId, manifest));
  if (!snapshot) {
    logger.warn(`GET /api/dso/ephemeris/${entry.dsoId}: manifest points to missing snapshot`);
    res.status(503).json({ error: 'DSO ephemeris unavailable. Try again shortly.' });
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('ETag', etag);
  res.json(snapshot);
}));

/** Ids of objects whose mission ended (the worker stopped asking). Never throws; no WARN spam from /health. */
export async function readEndedDsoIds(): Promise<ReadonlySet<string>> {
  return new Set(Object.keys((await readDsoEndedState({ quiet: true })).objects));
}

/**
 * The DSO part of /health. NEVER throws and is bounded by DSO_READ_TIMEOUT_MS: if the
 * DSO data cannot be read in time (missing volume, corrupt manifest, hung disk) it
 * returns zeros and `dsoError: true`, and the rest of /health is unaffected. It reads
 * files only; it never waits on the worker.
 */
export async function readDsoHealth(
  timeoutMs: number = DSO_READ_TIMEOUT_MS,
): Promise<ReturnType<typeof summarizeDsoHealth> & { dsoError?: true }> {
  try {
    const [manifest, ended] = await withDsoTimeout(
      Promise.all([readDsoManifest(), readEndedDsoIds()]),
      timeoutMs,
    );
    return summarizeDsoHealth(manifest, ended);
  } catch (err) {
    logger.warn(`/health: DSO status unavailable (${(err as Error)?.message ?? String(err)})`);
    return {
      dsoEnabledCount: 0,
      dsoFreshCount: 0,
      dsoStaleCount: 0,
      dsoDegradedCount: 0,
      dsoUnavailableCount: 0,
      dsoEndedCount: 0,
      dsoWorkerLastRunAt: null,
      dsoError: true,
    };
  }
}

/**
 * Counts for /health. An object whose mission ended and that still has its stored
 * ephemeris is counted as `dsoEndedCount`, not as fresh/stale/degraded: it is finished,
 * not broken, and the manifest's `fresh` for it is only the state at its last publish.
 * (The per-object `freshnessState` in the manifest and catalog is a shared contract
 * type with no 'ended' value, so it is left alone.)
 */
export function summarizeDsoHealth(
  manifest: Awaited<ReturnType<typeof readDsoManifest>>,
  endedIds: ReadonlySet<string> = new Set(),
) {
  const enabledEntries = getEnabledDsoRegistryEntries();
  const summary = {
    dsoEnabledCount: enabledEntries.length,
    dsoFreshCount: 0,
    dsoStaleCount: 0,
    dsoDegradedCount: 0,
    dsoUnavailableCount: 0,
    dsoEndedCount: 0,
    dsoWorkerLastRunAt: manifest?.workerLastRunAt ?? null,
  };

  for (const entry of enabledEntries) {
    const status = manifest?.objects[entry.dsoId];
    const state = status?.freshnessState ?? 'unavailable';
    if (endedIds.has(entry.dsoId) && status?.currentSnapshotVersion) summary.dsoEndedCount += 1;
    else if (state === 'fresh') summary.dsoFreshCount += 1;
    else if (state === 'stale') summary.dsoStaleCount += 1;
    else if (state === 'degraded') summary.dsoDegradedCount += 1;
    else summary.dsoUnavailableCount += 1;
  }

  return summary;
}

export default router;
