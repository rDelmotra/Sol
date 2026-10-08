import pg from 'pg';
import { logger } from '../../utils/logger.js';

// ============================================================
// History DB connection pool — lazy, optional, graceful.
//
// History is an ADDITIVE, OPTIONAL feature. The existing backend (/api/tle/all
// etc.) must boot and run exactly as before when no database is configured.
//
//   isHistoryEnabled()  → DATABASE_URL is set (config intent).
//   isHistoryReady()    → enabled AND migrations have applied successfully
//                         (set once at boot by initHistory). Routes and the
//                         ingest hook gate on READY, never just enabled.
//
// The pool is created lazily on first getPool() and is never created at import
// time, so importing this module is side-effect free.
//
// `pg` is CommonJS and its named exports are not statically analyzable under
// native ESM — hence the default-import + destructure for the runtime value.
// Type-only named imports are erased and safe.
// ============================================================

import type { PoolConfig } from 'pg';
import { databaseUrl, historyDbSsl, historyDbPoolMax } from '../../utils/config.js';

const { Pool } = pg;

const DATABASE_URL = databaseUrl();
const enabled = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;

let pool: pg.Pool | null = null;
let ready = false;

/** True when DATABASE_URL is configured (history feature is opted in). */
export function isHistoryEnabled(): boolean {
  return enabled;
}

/** True when history is enabled AND the schema migrated successfully at boot. */
export function isHistoryReady(): boolean {
  return enabled && ready;
}

/** Flip the ready flag — called by initHistory() after a clean migration. */
export function markHistoryReady(): void {
  ready = true;
}

/**
 * TLS configuration. Managed Postgres (Railway external, Timescale Cloud) almost
 * always needs TLS, frequently with a chain Node won't verify by default. A local
 * docker instance needs none. One knob keeps the URL clean across environments:
 *   HISTORY_DB_SSL=require    → TLS, skip cert verification (typical managed PG)
 *   HISTORY_DB_SSL=verify     → TLS, verify the chain
 *   unset | disable           → no TLS (local / internal network)
 */
function sslOption(): PoolConfig['ssl'] {
  return historyDbSsl();
}

/**
 * Return the shared pool, creating it on first use. Returns null when history is
 * disabled or pool construction throws — callers must handle null gracefully.
 */
export function getPool(): pg.Pool | null {
  if (!enabled) return null;
  if (pool) return pool;
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: historyDbPoolMax(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: sslOption(),
    });
    // An idle client erroring (e.g. server restart) must never crash the process.
    pool.on('error', (err) => logger.error('History DB idle client error:', err.message));
    return pool;
  } catch (err) {
    logger.error('History DB pool creation failed:', (err as Error).message);
    return null;
  }
}

/** Close the pool (tests / graceful shutdown). Safe to call when never opened. */
export async function closeHistory(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  ready = false;
  try {
    await p.end();
  } catch (err) {
    logger.warn('History DB pool close failed:', (err as Error).message);
  }
}
