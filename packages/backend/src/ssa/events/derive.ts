// ============================================================
// deriveDay: the change detection of one UTC day, end to end. Load the catalog of the day before and of the day itself from
// omm_updates -> appeared / disappeared / orbit changes -> formations -> write ssa_event (one transaction).
// A failed formation pass does not lose the rest: the day is written without close.formation (its earlier rows, if any, stay).
// ============================================================
import type { Pool } from 'pg';
import { logger } from '../../utils/logger.js';
import { deriveChanges, type ChangeStats } from './changes.js';
import { dayStartMs, loadDayCatalog, loadFirstSeen, prevDay } from './catalog.js';
import { deriveFormations, type FormationStats } from './formation.js';
import { CHANGE_KINDS, type ChangeKind, type EventRow } from './types.js';
import { writeDayEvents } from './writer.js';

export interface DeriveDayOpts {
  /** skip the formation pass (default false) */
  skipFormation?: boolean;
  /** compute only; do not write */
  dryRun?: boolean;
  /** minimum objects in either catalog; below it the day is not derived (an empty catalog would report every object as new / gone) */
  minObjects?: number;
}

export interface DeriveDayResult {
  day: string;
  status: 'written' | 'dry-run' | 'no-catalog';
  prevObjects: number;
  curObjects: number;
  perKind: Record<string, number>;
  changes?: ChangeStats;
  formation?: FormationStats;
  formationError?: string;
  wallS: number;
}

export async function deriveDay(pool: Pool, day: string, opts: DeriveDayOpts = {}): Promise<DeriveDayResult> {
  const T = Date.now();
  const wall = () => +((Date.now() - T) / 1000).toFixed(1);
  const minObjects = opts.minObjects ?? 1000;
  const t0 = dayStartMs(day);
  if (!Number.isFinite(t0)) throw new Error(`deriveDay: bad day '${day}'`);
  const [prev, cur] = [await loadDayCatalog(pool, prevDay(day)), await loadDayCatalog(pool, day)];
  if (prev.length < minObjects || cur.length < minObjects) {
    logger.warn(`SSA changes ${day}: catalogs too small (${prev.length} before, ${cur.length} after; need ${minObjects}); skipped`);
    return { day, status: 'no-catalog', prevObjects: prev.length, curObjects: cur.length, perKind: {}, wallS: wall() };
  }
  const prevIds = new Set(prev.map((o) => o.noradId));
  const appearedIds = cur.filter((o) => !prevIds.has(o.noradId)).map((o) => o.noradId);
  const firstSeen = await loadFirstSeen(pool, appearedIds);
  const { rows, stats: changes } = deriveChanges(prev, cur, t0, { firstSeen: (id) => firstSeen.get(id) });

  const out: EventRow[] = [...rows];
  const kinds: ChangeKind[] = CHANGE_KINDS.filter((k) => k !== 'close.formation');
  let formation: FormationStats | undefined;
  let formationError: string | undefined;
  if (!opts.skipFormation) {
    try {
      const f = deriveFormations(cur, t0);
      out.push(...f.rows);
      formation = f.stats;
      kinds.push('close.formation');
    } catch (err) {
      formationError = (err as Error).message;
      logger.warn(`SSA changes ${day}: formation pass failed (${formationError}); writing the other kinds`);
    }
  }
  const perKind: Record<string, number> = Object.fromEntries(kinds.map((k) => [k, 0]));
  for (const r of out) perKind[r.kind] = (perKind[r.kind] ?? 0) + 1;
  if (opts.dryRun) return { day, status: 'dry-run', prevObjects: prev.length, curObjects: cur.length, perKind, changes, ...(formation ? { formation } : {}), ...(formationError ? { formationError } : {}), wallS: wall() };
  // the day is marked done only when every kind was written: a failed formation pass leaves it for the next catch-up tick
  await writeDayEvents(pool, day, kinds, out, formationError ? undefined : { stats: { perKind, prevObjects: prev.length, curObjects: cur.length, wallS: wall() } });
  logger.info(`SSA changes ${day}: ${Object.entries(perKind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  return { day, status: 'written', prevObjects: prev.length, curObjects: cur.length, perKind, changes, ...(formation ? { formation } : {}), ...(formationError ? { formationError } : {}), wallS: wall() };
}
