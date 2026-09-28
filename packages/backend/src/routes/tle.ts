import { Router, Request, Response } from 'express';
import type { CatalogResponse } from '@orbitwatch/contracts';
import {
  isVisualCacheFresh,
  readCache,
  readVersion,
  readVisualCache,
  writeVisualCache,
} from '../cache/file-cache.js';
import type { VisualNoradCache } from '../cache/file-cache.js';
import { getTlePayload } from '../cache/tle-payload-cache.js';
import { fetchCelesTrakVisualNoradIds } from '../services/celestrak-visual.js';
import { logger } from '../utils/logger.js';
import {
  buildVisualEndpointResponse,
  resolveVisualPayload,
  type VisualDataSource,
} from './tle-visual.js';

const router = Router();
let visualRefreshInFlight: Promise<VisualNoradCache> | null = null;

async function refreshVisualCache(): Promise<VisualNoradCache> {
  if (!visualRefreshInFlight) {
    visualRefreshInFlight = (async () => {
      const ids = await fetchCelesTrakVisualNoradIds();
      return writeVisualCache(ids);
    })().finally(() => {
      visualRefreshInFlight = null;
    });
  }

  return visualRefreshInFlight;
}

function sendVisualResponse(
  req: Request,
  res: Response,
  payload: VisualNoradCache,
  source: VisualDataSource,
  stale: boolean,
): void {
  const etag = `"${payload.version}"`;
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('Cache-Control', stale ? 'public, max-age=300' : 'public, max-age=3600');
  res.setHeader('ETag', etag);
  if (stale) {
    res.setHeader('X-Data-Stale', '1');
  }
  res.json(buildVisualEndpointResponse(payload, source, stale));
}

// ============================================================
// GET /api/tle/all
//
// Returns the full enriched TLE dataset.
// Served from the version-keyed, pre-gzipped payload in
// cache/tle-payload-cache.ts (compression() skips it — Content-Encoding is
// already set). ~27 MB uncompressed for the ~32k-object catalog.
//
// Headers:
//   Cache-Control: public, max-age=3600   (clients may cache for 1 hour)
//   ETag: "<version timestamp>"           (for conditional GET support)
//
// 503 is returned when no cache exists yet (first boot before the initial
// fetch cycle completes).
// ============================================================
router.get('/all', (req: Request, res: Response) => {
  // The response body is built once per data version and held pre-gzipped in
  // memory; the hot path is a version compare + a buffer write (no 13.8 MB
  // read/parse/stringify/gzip per request).
  const payload = getTlePayload();
  if (!payload) {
    logger.warn('GET /api/tle/all: no cache available yet');
    res.status(503).json({ error: 'Data not yet available. Try again in a few seconds.' });
    return;
  }

  // Support conditional GET: if the client's ETag matches the current version,
  // skip sending the body and return 304 Not Modified.
  if (req.headers['if-none-match'] === payload.etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('ETag', payload.etag);
  res.setHeader('Vary', 'Accept-Encoding');

  if (req.acceptsEncodings(['gzip'])) {
    // Serve the pre-gzipped buffer directly. compression() skips re-encoding
    // because Content-Encoding is already set (non-identity).
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', payload.gzip.length);
    res.end(payload.gzip);
    return;
  }

  // Rare client without gzip support — fall back to the parse + serialize path.
  const data = readCache();
  if (!data) {
    res.status(503).json({ error: 'Cache read error. Try again shortly.' });
    return;
  }
  res.json({ version: payload.version, count: payload.count, data } satisfies CatalogResponse);
});

// ============================================================
// GET /api/tle/visual
//
// Returns the CelesTrak "visual" group as NORAD IDs. This endpoint serves
// from a local cache when available and refreshes from CelesTrak when stale.
// On upstream failure, stale cache is served rather than failing hard.
// ============================================================
router.get('/visual', async (req: Request, res: Response) => {
  const cached = readVisualCache();
  const resolved = await resolveVisualPayload(
    cached,
    Boolean(cached && isVisualCacheFresh()),
    refreshVisualCache,
  );

  if (resolved.kind === 'ok') {
    if (resolved.refreshError) {
      logger.warn(
        `GET /api/tle/visual: serving stale cache after fetch failure: ${resolved.refreshError}`,
      );
    }
    sendVisualResponse(req, res, resolved.payload, resolved.source, resolved.stale);
    return;
  }

  logger.error(
    `GET /api/tle/visual: upstream fetch failed and no cache exists: ${resolved.message}`,
  );
  res.status(503).json({ error: 'Visual list unavailable. Try again shortly.' });
  return;
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
