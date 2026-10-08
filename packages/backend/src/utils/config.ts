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
