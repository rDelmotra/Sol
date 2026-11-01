// ============================================================
// SSA provider — per-object encounter + manoeuvre fields from the history
// database (Layer 1 of the Perceptor integration).
//
// Serves nine FIELD_REGISTRY nouns (encounterCount36h … inFormation) from two
// compact in-memory maps built with ONE aggregate SQL per source table:
//   - conjunction (current run, miss <= 5 km), grouped per object over the pair
//   - ssa_event (elements.jump / object.appeared / close.formation), grouped per
//     object over unnest(subjects)
//
// getField() never does I/O. A throttled check (every CHECK_INTERVAL_MS, async,
// off the read path) compares a cheap signature — latest ssa_run id plus
// ssa_event max(id)/count — and reloads only when it changed (or the data is
// older than MAX_AGE_MS, because the 30-day/2-day windows slide with the clock).
// A failed check keeps serving the previous data. Until the first load
// finishes, and whenever history is disabled, every field reads null.
//
// "now"-relative values (nextEncounterAt, manoeuvreCount30d, inFormation) are
// evaluated against the program's bound time tMs from per-object time arrays,
// so they stay correct between reloads.
// ============================================================

import type { FieldValue } from '@orbitwatch/analytic';
import { logger } from '../../utils/logger.js';
import type { FieldProvider } from '../types.js';

export const SSA_FIELDS = [
  'encounterCount36h',
  'closestEncounterKm',
  'maxEncounterPc',
  'nextEncounterAt',
  'lastManoeuvreAt',
  'manoeuvreCount30d',
  'lastManoeuvreDeltaAKm',
  'appearedAt',
  'inFormation',
] as const;

/** An encounter is a predicted close approach at or under this miss distance. */
export const ENCOUNTER_MAX_MISS_KM = 5;
const DAY_MS = 86_400_000;
const MANOEUVRE_WINDOW_DAYS = 30;
const FORMATION_WINDOW_DAYS = 2;
/** How far back jump timestamps are loaded as arrays (window + slack for staleness). */
const JUMP_LOAD_DAYS = MANOEUVRE_WINDOW_DAYS + 5;

export const KIND_JUMP = 'elements.jump';
export const KIND_APPEARED = 'object.appeared';
export const KIND_FORMATION = 'close.formation';

const CHECK_INTERVAL_MS = 60_000;
const MAX_AGE_MS = 6 * 3_600_000;

export interface SsaQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SsaProviderDeps {
  /** A queryable, or null when history is unavailable. Re-evaluated at every check. */
  getDb: () => SsaQueryable | null;
  /** Config intent (DATABASE_URL set) — drives boot coverage, independent of readiness. */
  isEnabled: () => boolean;
  nowMs?: () => number;
  checkIntervalMs?: number;
  maxAgeMs?: number;
}

interface EncounterAgg {
  count: number;
  closestKm: number;
  maxPc: number | null;
  /** Ascending TCAs (epoch ms) of the object's encounters. */
  tcas: Float64Array;
}

interface EventAgg {
  lastJumpMs: number | null;
  lastJumpDa: number | null;
  /** Ascending jump times within the load window. */
  jumpTimes: Float64Array | null;
  appearedMs: number | null;
  formationMs: number | null;
}

export interface SsaProvider extends FieldProvider {
  /** Force a check + reload-if-changed now; resolves true when data was reloaded. Never rejects. */
  refresh(): Promise<boolean>;
  stats(): { loaded: boolean; signature: string | null; encounterObjects: number; eventObjects: number; loadedAtMs: number | null; loadMs: number | null };
  /** Boot-coverage hint: the registry skips per-object measurement for these fields. */
  coverageHint(field: string): number | null;
}

// One SQL per table. $1 = run id; the pair is unnested so each side gets the row.
const ENCOUNTER_SQL = `
  SELECT o.norad AS norad,
         count(*)::int AS n,
         min(c.miss_km) AS closest,
         max(c.pc) AS max_pc,
         array_agg(extract(epoch FROM c.tca) * 1000 ORDER BY c.tca) AS tcas
    FROM conjunction c
   CROSS JOIN LATERAL (VALUES (c.norad_a), (c.norad_b)) AS o(norad)
   WHERE c.last_run = $1 AND c.miss_km <= $2
   GROUP BY o.norad`;

const EVENT_SQL = `
  SELECT s.norad AS norad, e.kind AS kind,
         max(COALESCE(e.t_end, e.t_start, e.day::timestamptz)) AS last_t,
         (array_agg(e.payload->>'da' ORDER BY COALESCE(e.t_end, e.t_start, e.day::timestamptz) DESC))[1] AS last_da,
         array_agg(extract(epoch FROM COALESCE(e.t_end, e.t_start, e.day::timestamptz)) * 1000
                   ORDER BY COALESCE(e.t_end, e.t_start, e.day::timestamptz))
           FILTER (WHERE COALESCE(e.t_end, e.t_start, e.day::timestamptz) >= $2::timestamptz) AS recent_times
    FROM ssa_event e
   CROSS JOIN LATERAL unnest(e.subjects) AS s(norad)
   WHERE e.kind = ANY($1::text[])
   GROUP BY s.norad, e.kind`;

const SIGNATURE_SQL = `
  SELECT (SELECT max(id) FROM ssa_run) AS run_id,
         (SELECT max(id) FROM ssa_event) AS ev_max,
         (SELECT count(*) FROM ssa_event) AS ev_n`;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function timeMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function toFloatArray(v: unknown): Float64Array {
  if (!Array.isArray(v)) return new Float64Array(0);
  const out: number[] = [];
  for (const x of v) { const n = num(x); if (n !== null) out.push(n); }
  return Float64Array.from(out).sort();
}

/** Count of ascending values in [lo, hi]. */
function countInRange(a: Float64Array, lo: number, hi: number): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! >= lo && a[i]! <= hi) n++;
  return n;
}

export function createSsaProvider(deps: SsaProviderDeps): SsaProvider {
  const nowMs = deps.nowMs ?? Date.now;
  const checkIntervalMs = deps.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const maxAgeMs = deps.maxAgeMs ?? MAX_AGE_MS;

  let encounters = new Map<number, EncounterAgg>();
  let events = new Map<number, EventAgg>();
  let hasRun = false;
  let loaded = false;
  let signature: string | null = null;
  let loadedAtMs: number | null = null;
  let loadMs: number | null = null;
  let lastCheckMs = -Infinity;
  let inFlight: Promise<boolean> | null = null;

  async function load(db: SsaQueryable, runId: number | null, sig: string): Promise<void> {
    const t0 = Date.now();
    const now = nowMs();
    const enc = new Map<number, EncounterAgg>();
    if (runId !== null) {
      const { rows } = await db.query(ENCOUNTER_SQL, [runId, ENCOUNTER_MAX_MISS_KM]);
      for (const r of rows) {
        const norad = num(r.norad);
        const closest = num(r.closest);
        if (norad === null || closest === null) continue;
        const tcas = toFloatArray(r.tcas);
        enc.set(norad, { count: tcas.length > 0 ? tcas.length : (num(r.n) ?? 0), closestKm: closest, maxPc: num(r.max_pc), tcas });
      }
    }

    const ev = new Map<number, EventAgg>();
    const since = new Date(now - JUMP_LOAD_DAYS * DAY_MS).toISOString();
    const { rows: evRows } = await db.query(EVENT_SQL, [[KIND_JUMP, KIND_APPEARED, KIND_FORMATION], since]);
    for (const r of evRows) {
      const norad = num(r.norad);
      if (norad === null) continue;
      const lastT = timeMs(r.last_t);
      let agg = ev.get(norad);
      if (!agg) {
        agg = { lastJumpMs: null, lastJumpDa: null, jumpTimes: null, appearedMs: null, formationMs: null };
        ev.set(norad, agg);
      }
      switch (r.kind) {
        case KIND_JUMP:
          agg.lastJumpMs = lastT;
          agg.lastJumpDa = num(r.last_da);
          agg.jumpTimes = toFloatArray(r.recent_times);
          break;
        case KIND_APPEARED: agg.appearedMs = lastT; break;
        case KIND_FORMATION: agg.formationMs = lastT; break;
      }
    }

    // Swap in one step so readers never see a half-built state.
    encounters = enc;
    events = ev;
    hasRun = runId !== null;
    loaded = true;
    signature = sig;
    loadedAtMs = now;
    loadMs = Date.now() - t0;
    logger.info(`SSA provider: ${enc.size} objects with encounters, ${ev.size} with events (run=${runId ?? 'none'}, ${loadMs} ms)`);
  }

  async function check(): Promise<boolean> {
    const db = deps.getDb();
    if (!db) return false;
    try {
      const { rows } = await db.query(SIGNATURE_SQL);
      const row = rows[0] ?? {};
      const runId = num(row.run_id);
      const sig = `${runId ?? 'none'}:${num(row.ev_max) ?? 'none'}:${num(row.ev_n) ?? 0}`;
      const stale = loadedAtMs === null || nowMs() - loadedAtMs >= maxAgeMs;
      if (loaded && sig === signature && !stale) return false;
      await load(db, runId, sig);
      return true;
    } catch (err) {
      logger.warn(`SSA provider refresh failed (serving ${loaded ? 'previous' : 'empty'} data): ${(err as Error).message}`);
      return false;
    }
  }

  function refresh(): Promise<boolean> {
    if (inFlight) return inFlight;
    lastCheckMs = nowMs();
    inFlight = check().finally(() => { inFlight = null; });
    return inFlight;
  }

  /** Read-path hook: schedule (never await) a throttled check. */
  function ensureFresh(): void {
    if (inFlight) return;
    if (nowMs() - lastCheckMs < checkIntervalMs) return;
    void refresh();
  }

  function getField(noradId: number, field: string, tMs: number): FieldValue {
    ensureFresh();
    if (!loaded) return null;
    switch (field) {
      case 'encounterCount36h': {
        // 0 for "no encounters" — null only when no screening run exists at all.
        if (!hasRun) return null;
        return encounters.get(noradId)?.count ?? 0;
      }
      case 'closestEncounterKm': return encounters.get(noradId)?.closestKm ?? null;
      case 'maxEncounterPc': return encounters.get(noradId)?.maxPc ?? null;
      case 'nextEncounterAt': {
        const tcas = encounters.get(noradId)?.tcas;
        if (!tcas) return null;
        for (let i = 0; i < tcas.length; i++) if (tcas[i]! >= tMs) return new Date(tcas[i]!).toISOString();
        return null;
      }
      case 'lastManoeuvreAt': {
        const t = events.get(noradId)?.lastJumpMs;
        return t === null || t === undefined ? null : new Date(t).toISOString();
      }
      case 'manoeuvreCount30d': {
        const times = events.get(noradId)?.jumpTimes;
        return times ? countInRange(times, tMs - MANOEUVRE_WINDOW_DAYS * DAY_MS, tMs) : 0;
      }
      case 'lastManoeuvreDeltaAKm': return events.get(noradId)?.lastJumpDa ?? null;
      case 'appearedAt': {
        const t = events.get(noradId)?.appearedMs;
        return t === null || t === undefined ? null : new Date(t).toISOString();
      }
      case 'inFormation': {
        const t = events.get(noradId)?.formationMs;
        return t !== null && t !== undefined && t >= tMs - FORMATION_WINDOW_DAYS * DAY_MS && t <= tMs + DAY_MS;
      }
      default: return null;
    }
  }

  return {
    id: 'ssa',
    fields: SSA_FIELDS,
    getField,
    refresh,
    stats: () => ({
      loaded, signature, encounterObjects: encounters.size, eventObjects: events.size, loadedAtMs, loadMs,
    }),
    // These nouns use null for "none", so a measured fraction means nothing. They count as
    // served (1) when history is configured and as unserved (0) when it is not.
    coverageHint: (field) => ((SSA_FIELDS as readonly string[]).includes(field) ? (deps.isEnabled() ? 1 : 0) : null),
  };
}
