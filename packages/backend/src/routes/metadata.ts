import { Router, type Request, type Response } from 'express';
import { getMetadata, getDecayedCatalog } from '../enrichment/store.js';

// ============================================================
// Rich-metadata routes (lazy — read the boot-loaded in-memory store, never the
// request path hits disk after the first load).
//
//   GET /api/metadata/:noradId   — full ObjectMetadata for the InfoCard
//   GET /api/catalog/decayed     — paginated decayed/deorbited browser rows
//
// Mounted at /api/metadata and /api/catalog respectively in index.ts.
// ============================================================

export const metadataRouter = Router();
export const catalogRouter = Router();

// ── GET /api/metadata/:noradId ────────────────────────────────────────────────
metadataRouter.get('/:noradId', (req: Request, res: Response) => {
  const noradId = parseInt(req.params.noradId, 10);
  if (!Number.isFinite(noradId)) {
    res.status(400).json({ error: 'Invalid NORAD id.' });
    return;
  }

  const meta = getMetadata(noradId);
  if (!meta) {
    res.status(404).json({ error: 'No metadata for this object.' });
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(meta);
});

// ── GET /api/catalog/decayed?offset&limit&q ───────────────────────────────────
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseClampedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

catalogRouter.get('/decayed', (req: Request, res: Response) => {
  const all = getDecayedCatalog();
  const q = (typeof req.query.q === 'string' ? req.query.q : '').trim().toLowerCase();
  const offset = parseClampedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = parseClampedInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  const filtered = q
    ? all.filter(
        (r) => r.name.toLowerCase().includes(q) || String(r.noradId).includes(q),
      )
    : all;

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    total: filtered.length,
    offset,
    limit,
    rows: filtered.slice(offset, offset + limit),
  });
});
