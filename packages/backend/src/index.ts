import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import tleRouter from './routes/tle.js';
import dsoRouter, { summarizeDsoHealth } from './routes/dso.js';
import {
  metadataRouter,
  catalogRouter,
  launchRouter,
  orgRouter,
  queryRouter,
} from './routes/metadata.js';
import queryCompileRouter from './routes/query.js';
import { isCacheFresh, readVersion, readCache } from './cache/file-cache.js';
import { primeTlePayload } from './cache/tle-payload-cache.js';
import { loadEnrichment, getDecayedCatalog } from './enrichment/store.js';
import { getAnalyticRegistry } from './analytic/index.js';
import { scheduleTLEUpdater } from './cron/tle-updater.js';
import { readDsoManifest } from './dso/snapshot/index.js';
import {
  initHistory,
  ingestCurrentGp,
  historyRouter,
  isHistoryEnabled,
  isHistoryReady,
} from './history/index.js';
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const isProd = process.env.NODE_ENV === 'production';

// ── Middleware ────────────────────────────────────────────────────────────────

// Security headers (X-Frame-Options, X-Content-Type-Options, HSTS, etc.)
// CSP extends helmet's defaults for the KTX2/Basis texture pipeline:
//   - worker-src 'self' blob:  → KTX2Loader spawns its transcoder Web Worker from a blob: URL
//   - script-src + 'unsafe-eval' → the Basis transcoder is an Emscripten/embind WASM build that
//     uses `new Function(...)` (craftInvokerFunction) to build its bindings, which needs full
//     'unsafe-eval' (the narrower 'wasm-unsafe-eval' only allows WASM *compilation*). Blob
//     workers inherit the document CSP and can't be given a narrower policy, so this applies
//     app-wide — an accepted tradeoff for a public, auth-less 3D viewer. Same-origin
//     .ktx2/.wasm fetches stay under default-src 'self'.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-eval'"],
      'worker-src': ["'self'", 'blob:'],
    },
  },
}));

// CORS — restrict to frontend domain in production, allow all in dev.
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : '*';
app.use(cors({ origin: corsOrigin }));

// Rate limiting on API routes — prevents abuse of the large TLE payload.
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,                   // 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
}));

// Gzip all JSON responses.  For the full TLE dataset (~4–6 MB uncompressed)
// this reduces payload to ~500 KB–1 MB.
app.use(compression());

app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/tle', tleRouter);
app.use('/api/dso', dsoRouter);
app.use('/api/metadata', metadataRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/launch', launchRouter);
app.use('/api/org', orgRouter);
app.use('/api/query', queryRouter);
app.use('/api/query', queryCompileRouter); // POST /api/query/compile + /api/query/ask (NL→IR)
// Optional history routes — 503 cleanly when DATABASE_URL is unset, so mounting
// unconditionally is safe.
app.use('/api/history', historyRouter);

// GET /health — used by load balancers and uptime monitors
app.get('/health', async (_req, res) => {
  const version = readVersion();
  const dsoManifest = await readDsoManifest();
  res.json({
    status: 'ok',
    lastUpdate: version?.version ?? null,
    objectCount: version?.count ?? 0,
    uptime: Math.floor(process.uptime()),
    ...summarizeDsoHealth(dsoManifest),
  });
});

// ── Static frontend (production only) ────────────────────────────────────────
if (isProd) {
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist, {
    setHeaders: (res, filePath) => {
      if (filePath.includes('/textures/')) {
        // .ktx2 filenames are content-hashed (earth-*.<hash>.ktx2) → cache forever.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.includes('/basis/')) {
        // Basis transcoder isn't hashed but is stable (ships with three) — cache a week.
        res.setHeader('Cache-Control', 'public, max-age=604800');
      } else if (filePath.endsWith('/sw.js')) {
        // Never HTTP-cache the Service Worker script itself, so updated versions are
        // picked up promptly. Service-Worker-Allowed lets it claim root scope.
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  }));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  logger.info(`OrbitWatch backend listening on port ${PORT}`);

  // Warm the in-memory enrichment store so the daily join + the metadata/catalog
  // routes don't pay the one-time disk read on first use. Degrades gracefully
  // (empty) if the build artifact is missing — the TLE/DSO backend is untouched.
  loadEnrichment();
  getDecayedCatalog();

  // Optional history DB: migrate + (best-effort) Timescale upgrade BEFORE the
  // updater runs, so the first ingest sees a ready schema. Any failure is
  // non-fatal — the TLE/DSO backend is untouched and /api/history/* 503s.
  if (isHistoryEnabled()) {
    try {
      await initHistory();
      logger.info('History DB ready (migrations applied)');
    } catch (err) {
      logger.error('History DB init failed (non-fatal — history disabled):', (err as Error).message);
    }
  }

  // If the cache is missing or older than the 24h TTL, kick off an immediate fetch.
  // The cron job is always scheduled so subsequent refreshes happen daily at 02:00 UTC.
  const needsImmediateFetch = !isCacheFresh();
  scheduleTLEUpdater(needsImmediateFetch);

  if (!needsImmediateFetch) {
    const version = readVersion();
    logger.info(`Serving cached data: ${version?.count} objects, version=${version?.version}`);
    // Cache is fresh at boot — warm the in-memory gzipped payload now so the
    // first /api/tle/all request doesn't pay the one-time rebuild. (The
    // immediate-fetch path warms via the cron updater after writeCache.)
    primeTlePayload();

    // Seed today's history from the already-fresh cache so accumulation starts
    // immediately even when no fetch runs this boot. Idempotent (ON CONFLICT
    // keeps the latest epoch) and non-fatal. The immediate-fetch path instead
    // ingests via the cron hook after writeCache.
    if (isHistoryReady()) {
      const cached = readCache();
      if (cached) {
        ingestCurrentGp(cached, null, 'cache').catch((err) =>
          logger.error('History boot-seed failed (non-fatal):', (err as Error).message),
        );
      }
    }
  }

  // P3 S2: measure the analytic server-executor's capability+coverage at boot.
  // Nothing routes to this yet (S4 lands /api/query/ask) — cheap, and it
  // surfaces artifact/provider problems at boot instead of first-query.
  try {
    const analyticSnapshot = getAnalyticRegistry().snapshot();
    for (const u of analyticSnapshot.universes) {
      logger.info(`analytic[${u.universe}]: ${u.spineSize.toLocaleString()} objects, ${u.fields.length} fields measured`);
    }
  } catch (err) {
    logger.error('Analytic registry snapshot failed (non-fatal):', (err as Error).message);
  }
});

export default app;
