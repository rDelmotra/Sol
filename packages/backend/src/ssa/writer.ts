// ============================================================
// Persistence of one screening run. One ssa_run row (unique per batch_time, so a re-run of the same batch time is a no-op), then
// each encounter either updates the conjunction it matches from an earlier run (same pair, TCA within 60 s: matchEncounters) or
// opens a new one; every encounter also adds a conjunction_update row (the history of its predictions). All in one transaction.
// ============================================================
import type { Pool, PoolClient } from 'pg';
import { matchEncounters } from './encounter.js';
import type { Encounter } from './types.js';

export const SSA_CODE_VERSION = 's6.1';
export const MATCH_TOL_MS = 60_000;
const CHUNK = 5000;

export interface RunInfo {
  batchTimeMs: number;
  elementCutoffMs: number | null;
  objects: number;
  durationS: number;
  codeVersion?: string;
}
export interface WriteResult {
  /** false when a run for this batch time already existed (nothing was written) */
  written: boolean;
  runId: number;
  inserted: number;
  updated: number;
}

function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

const UNNEST_TYPES = `$1::float8[], $2::float8[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::text[], $8::float8[], $9::float8[], $10::float8[], $11::boolean[], $12::text[]`;
const NAMES = `tca, miss, vrel, r, i, c, volume, pc, pcmax, hbr, man, label`;

function arrays(es: Encounter[]): unknown[] {
  return [
    es.map((e) => e.tcaMs), es.map((e) => e.missKm), es.map((e) => e.vrelKms),
    es.map((e) => e.ricKm[0]), es.map((e) => e.ricKm[1]), es.map((e) => e.ricKm[2]),
    es.map((e) => e.volume), es.map((e) => e.pc), es.map((e) => e.pcMax), es.map((e) => e.hbrKm),
    es.map((e) => e.manoeuvrable), es.map((e) => e.label),
  ];
}

async function writeInTransaction(c: PoolClient, run: RunInfo, encounters: Encounter[]): Promise<WriteResult> {
  const ins = await c.query<{ id: string }>(
    `INSERT INTO ssa_run (batch_time, element_cutoff, objects, encounters, duration_s, code_version)
     VALUES (to_timestamp($1::float8 / 1000.0), CASE WHEN $2::float8 IS NULL THEN NULL ELSE to_timestamp($2::float8 / 1000.0) END, $3, $4, $5, $6)
     ON CONFLICT (batch_time) DO NOTHING RETURNING id`,
    [run.batchTimeMs, run.elementCutoffMs, run.objects, encounters.length, run.durationS, run.codeVersion ?? SSA_CODE_VERSION],
  );
  if (ins.rowCount === 0) {
    const ex = await c.query<{ id: string }>('SELECT id FROM ssa_run WHERE batch_time = to_timestamp($1::float8 / 1000.0)', [run.batchTimeMs]);
    return { written: false, runId: Number(ex.rows[0]!.id), inserted: 0, updated: 0 };
  }
  const runId = Number(ins.rows[0]!.id);

  // encounters of earlier runs that this run can re-predict: same pair, TCA within the tolerance of some new TCA
  let prevIds: number[] = [], prevKeys: Array<{ a: number; b: number; tca: number }> = [];
  if (encounters.length) {
    let lo = Infinity, hi = -Infinity;
    for (const e of encounters) { if (e.tcaMs < lo) lo = e.tcaMs; if (e.tcaMs > hi) hi = e.tcaMs; }
    const r = await c.query<{ id: string; norad_a: number; norad_b: number; tca_ms: number }>(
      `SELECT id, norad_a, norad_b, extract(epoch FROM tca) * 1000 AS tca_ms FROM conjunction
       WHERE tca BETWEEN to_timestamp(($1::float8 - $3::float8) / 1000.0) AND to_timestamp(($2::float8 + $3::float8) / 1000.0)
         AND last_run IN (SELECT id FROM ssa_run WHERE batch_time < to_timestamp($4::float8 / 1000.0))`,
      [lo, hi, MATCH_TOL_MS, run.batchTimeMs],
    );
    prevIds = r.rows.map((x) => Number(x.id));
    prevKeys = r.rows.map((x) => ({ a: x.norad_a, b: x.norad_b, tca: Number(x.tca_ms) }));
  }
  const m = matchEncounters(prevKeys, encounters.map((e) => ({ a: e.noradA, b: e.noradB, tca: e.tcaMs })), MATCH_TOL_MS);

  const matched: Array<{ e: Encounter; id: number }> = [];
  const fresh: Encounter[] = [];
  encounters.forEach((e, j) => { const i = m[j]!; if (i >= 0) matched.push({ e, id: prevIds[i]! }); else fresh.push(e); });

  // new conjunctions get their ids up front so the update rows can reference them
  const freshIds: number[] = [];
  for (const part of chunks(fresh, 50_000)) {
    const r = await c.query<{ id: string }>(`SELECT nextval(pg_get_serial_sequence('conjunction', 'id')) AS id FROM generate_series(1, $1::int)`, [part.length]);
    for (const x of r.rows) freshIds.push(Number(x.id));
  }

  let k = 0;
  for (const part of chunks(fresh, CHUNK)) {
    const ids = freshIds.slice(k, k + part.length);
    k += part.length;
    await c.query(
      `INSERT INTO conjunction (id, norad_a, norad_b, tca, miss_km, vrel_kms, ric_km, volume, pc, pc_max, hbr_km, manoeuvrable, label, first_run, last_run, n_updates)
       SELECT u.id, u.a, u.b, to_timestamp(u.tca / 1000.0::float8), u.miss, u.vrel, ARRAY[u.r, u.i, u.c]::float8[], u.volume, u.pc, u.pcmax, u.hbr, u.man, u.label, $13::bigint, $13::bigint, 1
       FROM unnest(${UNNEST_TYPES}, $14::bigint[], $15::int[], $16::int[]) AS u(${NAMES}, id, a, b)`,
      [...arrays(part), runId, ids, part.map((e) => e.noradA), part.map((e) => e.noradB)],
    );
  }

  for (const part of chunks(matched, CHUNK)) {
    const es = part.map((x) => x.e);
    await c.query(
      `UPDATE conjunction c SET tca = to_timestamp(u.tca / 1000.0::float8), miss_km = u.miss, vrel_kms = u.vrel, ric_km = ARRAY[u.r, u.i, u.c]::float8[],
         volume = u.volume, pc = u.pc, pc_max = u.pcmax, hbr_km = u.hbr, manoeuvrable = u.man, label = u.label,
         last_run = $13::bigint, n_updates = c.n_updates + 1
       FROM unnest(${UNNEST_TYPES}, $14::bigint[]) AS u(${NAMES}, id) WHERE c.id = u.id`,
      [...arrays(es), runId, part.map((x) => x.id)],
    );
  }

  const all: Array<{ e: Encounter; id: number }> = [...matched, ...fresh.map((e, i) => ({ e, id: freshIds[i]! }))];
  for (const part of chunks(all, CHUNK)) {
    const es = part.map((x) => x.e);
    await c.query(
      `INSERT INTO conjunction_update (conjunction_id, run_id, tca, miss_km, pc, pc_max, ric_km)
       SELECT u.id, $13::bigint, to_timestamp(u.tca / 1000.0::float8), u.miss, u.pc, u.pcmax, ARRAY[u.r, u.i, u.c]::float8[]
       FROM unnest(${UNNEST_TYPES}, $14::bigint[]) AS u(${NAMES}, id)`,
      [...arrays(es), runId, part.map((x) => x.id)],
    );
  }
  return { written: true, runId, inserted: fresh.length, updated: matched.length };
}

/** Write one run and its encounters in one transaction. A run for the same batch time that already exists is left untouched. */
export async function writeRun(pool: Pool, run: RunInfo, encounters: Encounter[]): Promise<WriteResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await writeInTransaction(c, run, encounters);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
