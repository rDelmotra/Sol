// Environment accessors. Functions (not a frozen object) on purpose: every call reads
// process.env afresh, so tests can mutate env at runtime and call-time readers
// (e.g. analytic-compiler) keep their timing. Does NOT import dotenv — entry points
// load it first. CACHE_DIR / HISTORY_ARCHIVE_DIR live in ./paths.ts.

export function port(): number {
  return process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
}

export function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Comma-separated allow-list, or '*' when unset/empty. */
export function corsOrigin(): string | string[] {
  const raw = process.env.CORS_ORIGIN;
  return raw ? raw.split(',').map(o => o.trim()) : '*';
}

/** Trimmed DATABASE_URL, or undefined when unset. (Empty string stays '' after trim.) */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim();
}

export type HistoryDbSsl = { rejectUnauthorized: boolean } | undefined;

export function historyDbSsl(): HistoryDbSsl {
  const mode = (process.env.HISTORY_DB_SSL ?? '').toLowerCase();
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode === 'verify') return { rejectUnauthorized: true };
  return undefined;
}

/** Positive integer from HISTORY_DB_POOL_MAX, else 8. */
export function historyDbPoolMax(): number {
  const raw = process.env.HISTORY_DB_POOL_MAX;
  if (!raw) return 8;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

export function spacetrackUser(): string | undefined {
  return process.env.SPACETRACK_USER;
}

export function spacetrackPass(): string | undefined {
  return process.env.SPACETRACK_PASS;
}

/** Raw ANALYTIC_COMPILER_MODEL (undefined/'' when unset). */
export function analyticCompilerModelRaw(): string | undefined {
  return process.env.ANALYTIC_COMPILER_MODEL;
}

/** Anthropic-path model: override or claude-haiku-4-5. */
export function analyticCompilerModel(): string {
  return process.env.ANALYTIC_COMPILER_MODEL || 'claude-haiku-4-5';
}

/** Gemini-path model: override only when it starts with "gemini". */
export function geminiCompilerModel(): string {
  const m = process.env.ANALYTIC_COMPILER_MODEL;
  return m && m.startsWith('gemini') ? m : 'gemini-3.1-flash-lite';
}

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY;
}

export function anthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

/**
 * Serve /api/tle/all as brotli when the client allows it. On by default; set
 * TLE_BROTLI to 0, off, false or no to turn it off (gzip only, as before).
 */
export function tleBrotliEnabled(): boolean {
  const v = (process.env.TLE_BROTLI ?? '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(v);
}

/** Brotli quality for the /api/tle/all copy: TLE_BROTLI_QUALITY as an integer 1 to 11, else 10. */
export function tleBrotliQuality(): number {
  const raw = process.env.TLE_BROTLI_QUALITY;
  if (!raw) return 10;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(11, Math.max(1, n)) : 10;
}

/**
 * CATALOG_MIN_RATIO: the smallest new catalog the updater will accept, as a share
 * of the cached one. A number from 0 to 1, default 0.5. 0 turns the size check off
 * (an empty catalog is still refused). Use it only if the real catalog shrank by
 * more than half on purpose, then unset it.
 */
export function catalogMinRatio(): number {
  const raw = process.env.CATALOG_MIN_RATIO;
  if (raw === undefined || raw.trim() === '') return 0.5;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/**
 * DSO_RETRY_ENDED=1 (or true, yes, on): retry deep-space objects that were marked
 * as ended, once per boot each. Use it when you know Horizons has new data for a
 * finished mission, then unset it. Off by default.
 */
export function dsoRetryEnded(): boolean {
  const v = (process.env.DSO_RETRY_ENDED ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}
