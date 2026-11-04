// ============================================================
// The change detection of one day from two catalogs already in memory (the file-based twin of events/derive.ts deriveDay, which loads
// them from the DB): appeared / disappeared / orbit changes, then formations. Same functions, same thresholds unless the era overrides
// them. Also the (de)serialisation of event rows to the lines of <out>/events/YYYY/YYYY-MM-DD.jsonl.gz, in the ssa_event table's shape:
//   { day, kind, subjects: number[], t_start: ISO, t_end: ISO, payload }
// ============================================================
import { deriveChanges, type ChangeStats } from '../events/changes.js';
import { deriveFormations, type FormationStats } from '../events/formation.js';
import { CHANGE_KINDS, type ChangeKind, type ChangeObject, type EventRow } from '../events/types.js';

export interface DeriveFilesOpts {
  skipFormation?: boolean;
  jumpDposKm?: number;
  jumpDaKm?: number;
  firstSeen?: (noradId: number) => string | undefined;
}
export interface DeriveFilesResult {
  rows: EventRow[];
  /** kinds whose rows are complete (close.formation is missing when its pass failed or was skipped) */
  kinds: ChangeKind[];
  perKind: Record<string, number>;
  changes: ChangeStats;
  formation?: FormationStats;
  formationError?: string;
}

export function deriveDayFromCatalogs(prev: ChangeObject[], cur: ChangeObject[], day: string, opts: DeriveFilesOpts = {}): DeriveFilesResult {
  const t0 = Date.parse(day + 'T00:00:00Z');
  const { rows, stats: changes } = deriveChanges(prev, cur, t0, {
    ...(opts.firstSeen ? { firstSeen: opts.firstSeen } : {}),
    ...(opts.jumpDposKm !== undefined ? { jumpDposKm: opts.jumpDposKm } : {}),
    ...(opts.jumpDaKm !== undefined ? { jumpDaKm: opts.jumpDaKm } : {}),
  });
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
    }
  }
  const perKind: Record<string, number> = Object.fromEntries(kinds.map((k) => [k, 0]));
  for (const r of out) perKind[r.kind] = (perKind[r.kind] ?? 0) + 1;
  return { rows: out, kinds, perKind, changes, ...(formation ? { formation } : {}), ...(formationError ? { formationError } : {}) };
}

/** A line of the events file. */
export interface EventLine { day: string; kind: ChangeKind; subjects: number[]; t_start: string; t_end: string; payload: Record<string, unknown> }

export const eventLine = (day: string, r: EventRow): EventLine => ({
  day, kind: r.kind, subjects: r.subjects, t_start: new Date(r.tStart).toISOString(), t_end: new Date(r.tEnd).toISOString(), payload: r.payload,
});
export const eventRow = (l: EventLine): EventRow => ({ kind: l.kind, subjects: l.subjects, tStart: Date.parse(l.t_start), tEnd: Date.parse(l.t_end), payload: l.payload });
