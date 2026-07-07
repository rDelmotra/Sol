import { Router, type Request, type Response } from 'express';
import {
  getMetadata,
  getDecayedCatalog,
  getLaunch,
  getOrg,
  getLaunchObjectIndex,
  primaryOwnerCode,
  loadQueryVocabRaw,
} from '../enrichment/store.js';
import type { OrgRecord } from '../enrichment/gcat/orgs.js';

// ============================================================
// Rich-metadata routes (lazy — read the boot-loaded in-memory store, never the
// request path hits disk after the first load).
//
//   GET /api/metadata/:noradId   — ObjectMetadata + composed launch/org context
//   GET /api/catalog/decayed     — paginated decayed/deorbited browser rows
//   GET /api/launch/:tag         — LaunchRecord + the noradIds it produced
//   GET /api/org/:code           — OrgRecord
//   GET /api/query/vocab         — search-vocab artifact (raw pass-through)
//
// Mounted at /api/metadata, /api/catalog, /api/launch, /api/org, /api/query in
// index.ts. Launch/org context is COMPOSED at request time from the boot-loaded
// entity maps (launches.json / orgs.json) — the per-object artifact stays normalized.
// ============================================================

export const metadataRouter = Router();
export const catalogRouter = Router();
export const launchRouter = Router();
export const orgRouter = Router();
export const queryRouter = Router();

/** Slim org projection embedded in responses (full record via /api/org/:code). */
function orgRef(code: string | null): { code: string; name: string; sectors: OrgRecord['sectors'] } | undefined {
  if (!code) return undefined;
  const org = getOrg(code);
  return org ? { code: org.code, name: org.name, sectors: org.sectors } : undefined;
}

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

  const launch = meta.launchTag ? getLaunch(meta.launchTag) : undefined;
  const manufacturerCode = meta.gcat?.manufacturer
    ? meta.gcat.manufacturer.split('/')[0].trim().replace(/\?$/, '')
    : null;

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    ...meta,
    ...(launch
      ? {
          launch: {
            ...launch,
            agencyNames: launch.agencies
              .map((a) => getOrg(a)?.name)
              .filter((n): n is string => Boolean(n)),
          },
        }
      : {}),
    ...(orgRef(primaryOwnerCode(meta)) ? { ownerOrg: orgRef(primaryOwnerCode(meta)) } : {}),
    ...(orgRef(manufacturerCode) ? { manufacturerOrg: orgRef(manufacturerCode) } : {}),
  });
});

// ── GET /api/launch/:tag ──────────────────────────────────────────────────────
launchRouter.get('/:tag', (req: Request, res: Response) => {
  const launch = getLaunch(req.params.tag);
  if (!launch) {
    res.status(404).json({ error: 'Unknown launch tag.' });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ launch, noradIds: getLaunchObjectIndex().get(launch.tag) ?? [] });
});

// ── GET /api/org/:code ────────────────────────────────────────────────────────
orgRouter.get('/:code', (req: Request, res: Response) => {
  const org = getOrg(req.params.code);
  if (!org) {
    res.status(404).json({ error: 'Unknown organization code.' });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(org);
});

// ── GET /api/query/vocab ──────────────────────────────────────────────────────
queryRouter.get('/vocab', (_req: Request, res: Response) => {
  const raw = loadQueryVocabRaw();
  if (!raw) {
    res.status(404).json({ error: 'Query vocab unavailable.' });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('application/json').send(raw);
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
