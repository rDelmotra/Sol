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
