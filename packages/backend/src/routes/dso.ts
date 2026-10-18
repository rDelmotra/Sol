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
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Wrap a DSO route so nothing it does can escape: a throw or rejection (corrupt JSON,
 * unreadable directory) becomes a fast 503 JSON, never an unhandled rejection.
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
  const catalog = await readDsoCatalog();
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
  const manifest = await readDsoManifest();
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

  const manifest = await readDsoManifest();
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

  const snapshot = await readCurrentDsoSnapshot(entry.dsoId, manifest);
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

/** The /health DSO failure is logged once, not on every probe; logging resumes after a good read. */
let healthFailureLogged = false;

/**
 * The DSO part of /health. NEVER throws: if the DSO data cannot be read (missing volume,
 * corrupt manifest) it returns zeros and `dsoError: true`, and the rest of /health is
 * unaffected. It reads files only; it never waits on the worker.
 */
export async function readDsoHealth(): Promise<ReturnType<typeof summarizeDsoHealth> & { dsoError?: true }> {
  try {
    const [manifest, ended] = await Promise.all([readDsoManifest(), readEndedDsoIds()]);
    healthFailureLogged = false;
    return summarizeDsoHealth(manifest, ended);
  } catch (err) {
    if (!healthFailureLogged) {
      healthFailureLogged = true;
      logger.warn(`/health: DSO status unavailable (${(err as Error)?.message ?? String(err)}); reported as dsoError, logged once`);
    }
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
