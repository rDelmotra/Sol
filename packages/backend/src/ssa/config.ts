// Environment settings of the SSA job (read at call time so tests can set them).
import { fileURLToPath } from 'node:url';

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** How many complete days back the catch-up loop looks (SSA_BACKFILL_DAYS, default 30). */
export const backfillDays = (): number => Math.max(1, Math.floor(num(process.env.SSA_BACKFILL_DAYS, 30)));
/** Directory of the star-map coverage files (SSA_COVERAGE_DIR). Default: packages/backend/data/ssa-coverage (data/ is gitignored). */
export const coverageDir = (): string => process.env.SSA_COVERAGE_DIR?.trim() || fileURLToPath(new URL('../../data/ssa-coverage/', import.meta.url));
/** Hourly (order 4) coverage is kept this many days (SSA_COVERAGE_HOURLY_DAYS, default 90); daily layers are kept forever. */
export const coverageHourlyDays = (): number => Math.max(0, Math.floor(num(process.env.SSA_COVERAGE_HOURLY_DAYS, 90)));
/** SSA_COVERAGE=0 switches the coverage part of the nightly job off. */
export const coverageEnabled = (): boolean => !['0', 'off', 'false'].includes((process.env.SSA_COVERAGE ?? '').trim().toLowerCase());
/** Worker threads for the coverage build and the pass refine (SSA_COVERAGE_WORKERS, default min(4, cores)). */
export const coverageWorkers = (cores: number): number => Math.max(1, Math.floor(num(process.env.SSA_COVERAGE_WORKERS, Math.min(4, cores))));

/**
 * Where the history backfill lives. SSA_HISTORY_DIR is a single root with elsets/YYYY/<day>.jsonl.gz, objects.jsonl.gz, coverage/<day>/...,
 * events/YYYY/<day>.jsonl.gz (and optionally era.json). The lab's own layout (merged/elsets, merged/objects.jsonl.gz, build/coverage,
 * build/events, era-merged.json) is read in place with the explicit overrides, each beating the root:
 *   SSA_HISTORY_ELSETS_DIR  SSA_HISTORY_OBJECTS  SSA_HISTORY_COVERAGE_DIR  SSA_HISTORY_EVENTS_DIR  SSA_HISTORY_ERA_FILE
 * Coverage reads fall back to the history coverage for days SSA_COVERAGE_DIR does not have, so live nightly lists and history coexist.
 */
export interface HistoryPaths { root: string | null; elsets: string | null; objects: string | null; coverage: string | null; events: string | null; eraFile: string | null }

const trimmed = (v: string | undefined): string | null => v?.trim() || null;
const under = (root: string | null, rel: string): string | null => (root ? `${root.replace(/\/+$/, '')}/${rel}` : null);

/** The paths for a root (null = overrides only) and the environment; null when nothing says where element sets or coverage are. */
export function historyPathsFrom(root: string | null, env: NodeJS.ProcessEnv = process.env): HistoryPaths | null {
  const p: HistoryPaths = {
    root,
    elsets: trimmed(env.SSA_HISTORY_ELSETS_DIR) ?? under(root, 'elsets'),
    objects: trimmed(env.SSA_HISTORY_OBJECTS) ?? under(root, 'objects.jsonl.gz'),
    coverage: trimmed(env.SSA_HISTORY_COVERAGE_DIR) ?? under(root, 'coverage'),
    events: trimmed(env.SSA_HISTORY_EVENTS_DIR) ?? under(root, 'events'),
    eraFile: trimmed(env.SSA_HISTORY_ERA_FILE) ?? under(root, 'era.json'),
  };
  return p.elsets || p.coverage ? p : null;
}
/** Configured history (SSA_HISTORY_DIR and/or the overrides), or null: the history API answers 503. */
export const historyPaths = (): HistoryPaths | null => historyPathsFrom(trimmed(process.env.SSA_HISTORY_DIR));
export const historyDir = (): string | null => trimmed(process.env.SSA_HISTORY_DIR);
export const historyCoverageDir = (root: string | null = historyDir()): string | null => historyPathsFrom(root)?.coverage ?? null;
