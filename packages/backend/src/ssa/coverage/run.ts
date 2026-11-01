// ============================================================
// The coverage part of the nightly job for one UTC day: catalog of the day from omm_updates -> build -> atomic write to the volume ->
// completion record (ssa_day_status) -> hourly retention. Each part is independent of the others (a failure here never blocks the
// changes part or the screen).
// ============================================================
import type { Pool } from 'pg';
import { logger } from '../../utils/logger.js';
import type { PartOutcome } from '../catchup.js';
import { markDone } from '../day-status.js';
import { coverageDir, coverageHourlyDays, coverageWorkers } from '../config.js';
import { cpus } from 'node:os';
import { buildDay, type BuildOpts } from './build.js';
import { dayStartMs, loadOmmCatalog } from './catalog.js';
import { hasDay, pruneHourly, writeDay } from './store.js';

export interface RunCoverageOpts extends BuildOpts {
  dir?: string;
  /** below this many objects the day is not built (an empty catalog would be a useless day) */
  minObjects?: number;
  now?: () => number;
}

export async function runCoverageDay(pool: Pool, day: string, o: RunCoverageOpts = {}): Promise<PartOutcome> {
  const dir = o.dir ?? coverageDir();
  const catalog = await loadOmmCatalog(pool, day);
  const min = o.minObjects ?? 1000;
  if (catalog.length < min) return { status: 'skipped', reason: `no-catalog (${catalog.length} element sets, need ${min})` };
  logger.info(`SSA coverage ${day}: building ${catalog.length} objects`);
  const built = await buildDay(day, dayStartMs(day), catalog, { workers: o.workers ?? coverageWorkers(cpus().length), ...(o.stepMs ? { stepMs: o.stepMs } : {}), ...(o.limit ? { limit: o.limit } : {}) });
  writeDay(dir, built.manifest, built.files);
  const m = built.manifest;
  await markDone(pool, day, 'coverage', {
    objects: m.objects, unindexed: m.unindexed.length, skipped: m.skipped, wallS: m.build.wallS, peakRssMB: m.build.peakRssMB,
    bytes: Object.fromEntries(Object.entries(m.layers).map(([k, v]) => [k, v.bytes])),
  });
  logger.info(`SSA coverage ${day}: ${m.objects} objects in ${m.build.wallS} s (sgp4 ${m.build.sgp4S} s), ${Object.entries(m.layers).map(([k, v]) => `${k} ${(v.bytes / 1e6).toFixed(1)} MB`).join(', ')}, peak RSS ${m.build.peakRssMB} MB`);
  const pruned = pruneHourly(dir, coverageHourlyDays(), (o.now ?? Date.now)());
  if (pruned.length) logger.info(`SSA coverage: hourly layer pruned for ${pruned.length} day(s) older than ${coverageHourlyDays()} days`);
  return { status: 'done', stats: m.build };
}

/** The coverage part for the job: runner + existence check. Absent (undefined) when SSA_COVERAGE is off. */
export function coverageJobPart(dir = coverageDir(), opts: RunCoverageOpts = {}): { run: (pool: Pool, day: string) => Promise<PartOutcome>; exists: (day: string) => boolean } {
  return { run: (pool, day) => runCoverageDay(pool, day, { ...opts, dir }), exists: (day) => hasDay(dir, day) };
}
