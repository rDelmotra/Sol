import type { Pool, PoolClient } from 'pg';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import type {
  HistoryCoverage,
  HistoryDimRow,
  HistoryFactRow,
  HistoryServingRow,
} from '../types.js';
import { reconstructEnriched } from '../serving/reconstruct.js';

// ============================================================
// SQL layer — the idempotent upsert (shared by the cron AND the future backfill)
// plus the as-of read used by serving.
// ============================================================

// Stay well under Postgres's 65 535-parameter ceiling: omm_daily has 22 bound
// columns/row → 1000 rows ≈ 22 000 params/statement.
const BATCH_SIZE = 1000;

// ── object_dim upsert ─────────────────────────────────────────────────────────
// 7 bound values/row: norad_id, object_name, object_id, country_code,
// launch_date, rcs_size, utc_day (utc_day fills both first_seen and last_seen).
const DIM_COLS = 7;

function dimValuesClause(rowCount: number): string {
  const tuples: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const b = r * DIM_COLS;
    // first_seen and last_seen both seed from the same $utc_day placeholder.
    tuples.push(
      `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 7})`,
    );
  }
  return tuples.join(',');
}

const DIM_UPSERT_HEAD =
  `INSERT INTO object_dim
     (norad_id, object_name, object_id, country_code, launch_date, rcs_size, first_seen, last_seen)
   VALUES `;

const DIM_UPSERT_TAIL = `
  ON CONFLICT (norad_id) DO UPDATE SET
    object_name  = EXCLUDED.object_name,
    object_id    = EXCLUDED.object_id,
    country_code = EXCLUDED.country_code,
    launch_date  = COALESCE(EXCLUDED.launch_date, object_dim.launch_date),
    rcs_size     = COALESCE(EXCLUDED.rcs_size, object_dim.rcs_size),
    first_seen   = LEAST(object_dim.first_seen, EXCLUDED.first_seen),
    last_seen    = GREATEST(object_dim.last_seen, EXCLUDED.last_seen)`;

async function upsertDimBatch(client: PoolClient, rows: HistoryDimRow[]): Promise<void> {
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(r.norad_id, r.object_name, r.object_id, r.country_code, r.launch_date, r.rcs_size, r.utc_day);
  }
  await client.query(DIM_UPSERT_HEAD + dimValuesClause(rows.length) + DIM_UPSERT_TAIL, params);
}

// ── omm_daily upsert ──────────────────────────────────────────────────────────
// 22 bound values/row, in column order below.
const FACT_COLS = 22;

function factValuesClause(rowCount: number): string {
  const tuples: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const b = r * FACT_COLS;
    const ph: string[] = [];
    for (let c = 1; c <= FACT_COLS; c++) ph.push(`$${b + c}`);
    tuples.push(`(${ph.join(',')})`);
  }
  return tuples.join(',');
}

const FACT_UPSERT_HEAD =
  `INSERT INTO omm_daily (
     norad_id, utc_day, epoch, mean_motion, eccentricity, inclination,
     ra_of_asc_node, arg_of_pericenter, mean_anomaly, bstar, mean_motion_dot,
     mean_motion_ddot, ephemeris_type, element_set_no, rev_at_epoch,
     classification_type, period, apogee_km, perigee_km, category, regime, source
   ) VALUES `;

// Daily-downsample: keep the LATEST elset within a UTC day. Whether rows arrive
// one-per-object (forward) or many-per-object-per-day (backfill), the table
// converges to one latest-per-day — so cron + backfill share this exact sink.
const FACT_UPSERT_TAIL = `
  ON CONFLICT (norad_id, utc_day) DO UPDATE SET
    epoch               = EXCLUDED.epoch,
    mean_motion         = EXCLUDED.mean_motion,
    eccentricity        = EXCLUDED.eccentricity,
    inclination         = EXCLUDED.inclination,
    ra_of_asc_node      = EXCLUDED.ra_of_asc_node,
    arg_of_pericenter   = EXCLUDED.arg_of_pericenter,
    mean_anomaly        = EXCLUDED.mean_anomaly,
    bstar               = EXCLUDED.bstar,
    mean_motion_dot     = EXCLUDED.mean_motion_dot,
    mean_motion_ddot    = EXCLUDED.mean_motion_ddot,
    ephemeris_type      = EXCLUDED.ephemeris_type,
    element_set_no      = EXCLUDED.element_set_no,
    rev_at_epoch        = EXCLUDED.rev_at_epoch,
    classification_type = EXCLUDED.classification_type,
    period              = EXCLUDED.period,
    apogee_km           = EXCLUDED.apogee_km,
    perigee_km          = EXCLUDED.perigee_km,
    category            = EXCLUDED.category,
    regime              = EXCLUDED.regime,
    source              = EXCLUDED.source,
    ingested_at         = now()
  WHERE EXCLUDED.epoch > omm_daily.epoch`;

async function upsertFactBatch(client: PoolClient, rows: HistoryFactRow[]): Promise<void> {
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.norad_id, r.utc_day, r.epoch, r.mean_motion, r.eccentricity, r.inclination,
      r.ra_of_asc_node, r.arg_of_pericenter, r.mean_anomaly, r.bstar, r.mean_motion_dot,
      r.mean_motion_ddot, r.ephemeris_type, r.element_set_no, r.rev_at_epoch,
      r.classification_type, r.period, r.apogee_km, r.perigee_km, r.category, r.regime, r.source,
    );
  }
  await client.query(FACT_UPSERT_HEAD + factValuesClause(rows.length) + FACT_UPSERT_TAIL, params);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Upsert dim + fact rows in a single transaction.
 *
 * Callers MUST pre-deduplicate (the sink does): Postgres rejects an upsert whose
 * VALUES touch the same conflict key twice in one statement. Dim is keyed by
 * norad_id, fact by (norad_id, utc_day).
 */
export async function upsertDailyBatch(
  pool: Pool,
  dimRows: HistoryDimRow[],
  factRows: HistoryFactRow[],
): Promise<void> {
  if (factRows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const batch of chunk(dimRows, BATCH_SIZE)) await upsertDimBatch(client, batch);
    for (const batch of chunk(factRows, BATCH_SIZE)) await upsertFactBatch(client, batch);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

const AS_OF_SQL = `
  SELECT DISTINCT ON (f.norad_id)
    f.norad_id,
    d.object_name, d.object_id, d.country_code,
    to_char(d.launch_date, 'YYYY-MM-DD') AS launch_date,
    d.rcs_size,
    f.epoch,
    f.mean_motion, f.eccentricity, f.inclination, f.ra_of_asc_node,
    f.arg_of_pericenter, f.mean_anomaly, f.bstar, f.mean_motion_dot, f.mean_motion_ddot,
    f.ephemeris_type, f.element_set_no, f.rev_at_epoch, f.classification_type,
    f.period, f.apogee_km, f.perigee_km, f.category, f.regime, f.ingested_at
  FROM omm_daily f
  JOIN object_dim d ON d.norad_id = f.norad_id
  WHERE f.utc_day <= $1::date
    AND f.utc_day > $1::date - INTERVAL '30 days'
  ORDER BY f.norad_id, f.utc_day DESC`;

export interface AsOfResult {
  objects: EnrichedTLEObject[];
  /** Max ingested_at across the returned rows — the day snapshot's freshness key. */
  maxIngestedAt: string | null;
}

/**
 * Catalog as it was on UTC `day` ('YYYY-MM-DD'): each object's latest elset on or
 * before that day, within a 30-day staleness window (so objects that stopped
 * being tracked before `day` are omitted, matching the live 30-day GP window).
 */
export async function getAsOfCatalog(pool: Pool, day: string): Promise<AsOfResult> {
  const { rows } = await pool.query<HistoryServingRow>(AS_OF_SQL, [day]);
  let maxIngestedAt: number | null = null;
  const objects: EnrichedTLEObject[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    objects[i] = reconstructEnriched(row);
    const t = row.ingested_at.getTime();
    if (maxIngestedAt === null || t > maxIngestedAt) maxIngestedAt = t;
  }
  return {
    objects,
    maxIngestedAt: maxIngestedAt === null ? null : new Date(maxIngestedAt).toISOString(),
  };
}

const COVERAGE_SQL = `
  SELECT
    to_char(min(f.utc_day), 'YYYY-MM-DD') AS from_day,
    to_char(max(f.utc_day), 'YYYY-MM-DD') AS to_day,
    max(f.ingested_at)                    AS last_ingest,
    (SELECT count(*)::int FROM object_dim) AS object_count
  FROM omm_daily f`;

interface CoverageRow {
  from_day: string | null;
  to_day: string | null;
  last_ingest: Date | null;
  object_count: number;
}

/** Span the history DB currently covers (drives the scrubber bounds). */
export async function getCoverage(pool: Pool): Promise<HistoryCoverage> {
  const { rows } = await pool.query<CoverageRow>(COVERAGE_SQL);
  const r = rows[0];
  return {
    from: r?.from_day ?? null,
    to: r?.to_day ?? null,
    objectCount: r?.object_count ?? 0,
    lastIngestAt: r?.last_ingest ? r.last_ingest.toISOString() : null,
  };
}
