import { Router, Request, Response } from 'express';
import { readCache, readVersion } from '../cache/file-cache.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ============================================================
// GET /api/tle/all
//
// Returns the full enriched TLE dataset.
// Response is gzip-compressed by the `compression` middleware applied in
// index.ts (~500 KB–1 MB compressed for 25 000 objects).
//
// Headers:
//   Cache-Control: public, max-age=3600   (clients may cache for 1 hour)
//   ETag: "<version timestamp>"           (for conditional GET support)
//
// 503 is returned when no cache exists yet (first boot before the initial
// fetch cycle completes).
// ============================================================
router.get('/all', (req: Request, res: Response) => {
  const version = readVersion();
  if (!version) {
    logger.warn('GET /api/tle/all: no cache available yet');
    res.status(503).json({ error: 'Data not yet available. Try again in a few seconds.' });
    return;
  }

  // Support conditional GET: if the client's ETag matches the current version,
  // skip sending the body and return 304 Not Modified.
  const etag = `"${version.version}"`;
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  const data = readCache();
  if (!data) {
    res.status(503).json({ error: 'Cache read error. Try again shortly.' });
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('ETag', etag);
  res.json({ version: version.version, count: data.length, data });
});

// ============================================================
// GET /api/tle/version
//
// Lightweight endpoint for clients to check whether they need to refetch
// the full dataset without downloading it.  Clients store the last-seen
// version string and poll this endpoint (e.g., hourly) to detect updates.
// ============================================================
router.get('/version', (_req: Request, res: Response) => {
  const version = readVersion();
  if (!version) {
    res.status(503).json({ error: 'Data not yet available.' });
    return;
  }
  res.json({ version: version.version, count: version.count });
});

export default router;
