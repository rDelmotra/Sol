import path from 'node:path';
import express, { type Express, type Router } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import tleRouter from './routes/tle.js';
import dsoRouter, { readEndedDsoIds, summarizeDsoHealth } from './routes/dso.js';
import {
  metadataRouter,
  catalogRouter,
  launchRouter,
  orgRouter,
  queryRouter,
} from './routes/metadata.js';
import { createQueryRouter } from './routes/query.js';
import { readVersion } from './cache/file-cache.js';
import { readDsoManifest } from './dso/snapshot/index.js';
import { historyRouter } from './history/index.js';
import { frontendDistDir } from './utils/paths.js';
import { IMMUTABLE_CACHE_CONTROL, isHashedAsset } from './utils/static-cache.js';
import { readDiskUsage } from './utils/disk-usage.js';
import { isProd as isProdEnv, corsOrigin as corsOriginEnv } from './utils/config.js';

export interface AppDeps {
  /** Override the NL→IR query router (compile + ask). Defaults to the real one. */
  queryRouter?: Router;
  /**
   * Built-frontend directory to serve (static files + SPA fallback). Defaults to the
   * real build in production and to nothing otherwise; tests pass a temp directory.
   */
  frontendDist?: string;
}

/**
 * Builds the express app: middleware, routes, /health, and (prod) the static
 * frontend. Does NOT listen and has no side effects beyond construction.
 */
export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.set('trust proxy', 1);
  const isProd = isProdEnv();

  // ── Middleware ──────────────────────────────────────────────────────────────

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
  const corsOrigin = corsOriginEnv();
  app.use(cors({ origin: corsOrigin }));

  // Rate limiting on API routes — prevents abuse of the large TLE payload.
  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 100,                   // 100 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Try again later.' },
  }));

  // Gzip JSON responses. (/api/tle/all bypasses this — it is served pre-gzipped
  // from cache/tle-payload-cache.ts; the full catalog is ~27 MB uncompressed.)
  app.use(compression());

  app.use(express.json());

  // ── Routes ──────────────────────────────────────────────────────────────────
  // Mount order is significant (the two /api/query routers share a prefix).

  const routes: Array<[string, Router]> = [
    ['/api/tle', tleRouter],
    ['/api/dso', dsoRouter],
    ['/api/metadata', metadataRouter],
    ['/api/catalog', catalogRouter],
    ['/api/launch', launchRouter],
    ['/api/org', orgRouter],
    ['/api/query', queryRouter],
    // POST /api/query/compile + /api/query/ask (NL→IR)
    ['/api/query', deps.queryRouter ?? createQueryRouter()],
    // Optional history routes — 503 cleanly when DATABASE_URL is unset, so mounting
    // unconditionally is safe.
    ['/api/history', historyRouter],
  ];
  for (const [prefix, router] of routes) app.use(prefix, router);

  // GET /health — used by load balancers and uptime monitors
  app.get('/health', async (_req, res) => {
    const version = readVersion();
    const dsoManifest = await readDsoManifest();
    const dsoEndedIds = await readEndedDsoIds();
    const disk = await readDiskUsage(); // data volume; null if the platform can't say
    res.json({
      status: 'ok',
      lastUpdate: version?.version ?? null,
      objectCount: version?.count ?? 0,
      uptime: Math.floor(process.uptime()),
      disk,
      ...summarizeDsoHealth(dsoManifest, dsoEndedIds),
    });
  });

  // ── Static frontend (production, or an explicit frontendDist) ───────────────
  const frontendDist = deps.frontendDist ?? (isProd ? frontendDistDir() : null);
  if (frontendDist) {
    app.use(express.static(frontendDist, {
      setHeaders: (res, filePath) => {
        if (filePath.includes('/textures/')) {
          // .ktx2 filenames are content-hashed (earth-*.<hash>.ktx2) → cache forever.
          res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
        } else if (filePath.includes('/basis/')) {
          // Basis transcoder isn't hashed but is stable (ships with three) — cache a week.
          res.setHeader('Cache-Control', 'public, max-age=604800');
        } else if (filePath.endsWith('/sw.js')) {
          // Never HTTP-cache the Service Worker script itself, so updated versions are
          // picked up promptly. Service-Worker-Allowed lets it claim root scope.
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Service-Worker-Allowed', '/');
        } else if (isHashedAsset(path.relative(frontendDist, filePath).split(path.sep).join('/'))) {
          // Vite's assets/name-HASH.ext: a new build means new names, and index.html (which
          // names them) is revalidated on every visit, so a year of caching cannot strand
          // anyone on an old build. The service worker does not touch /assets/.
          res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
        }
        // Everything else (index.html, favicon, manifest, ...) keeps express's default
        // "public, max-age=0" with ETag, so the browser revalidates it each time.
      },
    }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  return app;
}
