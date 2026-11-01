// ============================================================
// SSA read-side queries (used by routes/ssa.ts). Parameterised SQL only; every
// function takes a pg Queryable so callers (and tests) choose the pool/search_path.
// "Current" encounters are conjunction rows whose last_run is the latest ssa_run.
// ============================================================

import type {
  EncounterDetail,
  EncounterObject,
  EncounterSummary,
  EncounterUpdate,
  SsaEvent,
  SsaRunInfo,
} from '@orbitwatch/contracts';

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export type ConjunctionSort = 'tca' | 'pc' | 'miss';

export interface ConjunctionFilter {
  norad?: number;
  from?: Date;
  to?: Date;
  minPc?: number;
  maxMissKm?: number;
  sort: ConjunctionSort;
  limit: number;
}

export interface EventFilter {
  kind?: string;
  since?: Date;
  norad?: number;
  limit: number;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : new Date(v).toISOString();
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** object_dim carries no type column; infer only what the catalogue name states outright. */
function objectTypeFromName(name: string | null): string | null {
  if (!name) return null;
  if (/\bDEB\b/.test(name)) return 'DEBRIS';
  if (/\bR\/B\b/.test(name)) return 'ROCKET BODY';
  return null;
}

function toObject(noradId: number, name: string | null, lastManoeuvreAt: Date | string | null | undefined): EncounterObject {
  const n = name && name.length > 0 ? name : null;
  return { noradId, name: n, objectType: objectTypeFromName(n), lastManoeuvreAt: iso(lastManoeuvreAt) };
}

function ric(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  return [Number(v[0]), Number(v[1]), Number(v[2])];
}

function toRun(r: any): SsaRunInfo {
  return {
    id: Number(r.id),
    batchTime: iso(r.batch_time)!,
    elementCutoff: iso(r.element_cutoff)!,
    objects: Number(r.objects),
    encounters: Number(r.encounters),
    durationS: Number(r.duration_s),
    codeVersion: r.code_version ?? '',
  };
}

const RUN_COLS = 'id, batch_time, element_cutoff, objects, encounters, duration_s, code_version';

export async function getLatestRun(db: Queryable): Promise<SsaRunInfo | null> {
  const { rows } = await db.query(`SELECT ${RUN_COLS} FROM ssa_run ORDER BY id DESC LIMIT 1`);
  return rows.length ? toRun(rows[0]) : null;
}

const CONJ_SELECT = `
  SELECT c.id, c.norad_a, c.norad_b, c.tca, c.miss_km, c.vrel_kms, c.ric_km, c.volume,
         c.pc, c.pc_max, c.hbr_km, c.manoeuvrable, c.label, c.n_updates, c.manoeuvre_a, c.manoeuvre_b,
         da.object_name AS name_a, db.object_name AS name_b, fr.batch_time AS first_seen
    FROM conjunction c
    LEFT JOIN object_dim da ON da.norad_id = c.norad_a
    LEFT JOIN object_dim db ON db.norad_id = c.norad_b
    LEFT JOIN ssa_run fr ON fr.id = c.first_run`;

function toSummary(r: any): EncounterSummary {
  return {
    id: Number(r.id),
    a: toObject(Number(r.norad_a), r.name_a, r.manoeuvre_a),
    b: toObject(Number(r.norad_b), r.name_b, r.manoeuvre_b),
    tca: iso(r.tca)!,
    missKm: Number(r.miss_km),
    relSpeedKms: Number(r.vrel_kms),
    ricKm: ric(r.ric_km) ?? [0, 0, 0],
    volume: r.volume ?? '',
    pc: num(r.pc),
    pcMax: num(r.pc_max),
    hardBodyRadiusKm: num(r.hbr_km),
    manoeuvrable: Boolean(r.manoeuvrable),
    label: r.label ?? null,
    firstSeen: iso(r.first_seen),
    updates: Number(r.n_updates ?? 0),
  };
}

const ORDER: Record<ConjunctionSort, string> = {
  tca: 'c.tca ASC, c.id ASC',
  pc: 'c.pc DESC NULLS LAST, c.tca ASC, c.id ASC',
  miss: 'c.miss_km ASC, c.tca ASC, c.id ASC',
};

export async function listCurrentEncounters(
  db: Queryable,
  runId: number,
  f: ConjunctionFilter,
): Promise<EncounterSummary[]> {
  const where: string[] = ['c.last_run = $1'];
  const vals: unknown[] = [runId];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replaceAll('?', () => `$${vals.length}`)); };
  if (f.norad !== undefined) add('(c.norad_a = ? OR c.norad_b = ?)', f.norad);
  if (f.from) add('c.tca >= ?', f.from);
  if (f.to) add('c.tca <= ?', f.to);
  if (f.minPc !== undefined) add('c.pc >= ?', f.minPc);
  if (f.maxMissKm !== undefined) add('c.miss_km <= ?', f.maxMissKm);
  vals.push(f.limit);
  const sql = `${CONJ_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${ORDER[f.sort]} LIMIT $${vals.length}`;
  const { rows } = await db.query(sql, vals);
  return rows.map(toSummary);
}

export async function getEncounterDetail(db: Queryable, id: number): Promise<EncounterDetail | null> {
  const { rows } = await db.query(`${CONJ_SELECT} WHERE c.id = $1`, [id]);
  if (!rows.length) return null;
  const hist = await db.query(
    `SELECT u.run_id, r.batch_time, u.tca, u.miss_km, u.pc, u.pc_max, u.ric_km
       FROM conjunction_update u JOIN ssa_run r ON r.id = u.run_id
      WHERE u.conjunction_id = $1 ORDER BY u.run_id ASC`,
    [id],
  );
  const history: EncounterUpdate[] = hist.rows.map((h) => ({
    runId: Number(h.run_id),
    batchTime: iso(h.batch_time)!,
    tca: iso(h.tca)!,
    missKm: Number(h.miss_km),
    pc: num(h.pc),
    pcMax: num(h.pc_max),
    ricKm: ric(h.ric_km),
  }));
  return { ...toSummary(rows[0]), history };
}

function toEvent(r: any): SsaEvent {
  const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
  return {
    id: Number(r.id),
    day,
    kind: r.kind,
    subjects: (r.subjects ?? []).map(Number),
    tStart: iso(r.t_start),
    tEnd: iso(r.t_end),
    payload: r.payload ?? null,
  };
}

export async function listEvents(db: Queryable, f: EventFilter): Promise<SsaEvent[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replaceAll('?', () => `$${vals.length}`)); };
  if (f.kind) add('kind = ?', f.kind);
  if (f.since) add('COALESCE(t_start, day::timestamptz) >= ?', f.since);
  if (f.norad !== undefined) add('subjects @> ARRAY[?]::int[]', f.norad);
  vals.push(f.limit);
  const sql = `SELECT id, to_char(day, 'YYYY-MM-DD') AS day, kind, subjects, t_start, t_end, payload
      FROM ssa_event ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(t_start, day::timestamptz) DESC, id DESC LIMIT $${vals.length}`;
  const { rows } = await db.query(sql, vals);
  return rows.map(toEvent);
}
