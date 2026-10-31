// ============================================================
// Catalog loaders for the screener. The core (screen.ts) takes an array of element sets; these build it.
//   loadCatalogFromDb     omm_updates (every published element set): per object the latest set with epoch <= batch time, joined with
//                         object_dim / omm_daily for the name, radar size class, object category, regime and perigee
//   fromEnriched          maps the app's current-GP records (the daily ingest's EnrichedTLEObject) to screener objects; the caller
//                         that holds the cache reader supplies those records (see nightly.ts, `fallback`)
// ============================================================
import type { Pool } from 'pg';
import type { SsaObject } from './types.js';

/** The fields of an EnrichedTLEObject (@orbitwatch/contracts) the screener reads. */
export interface EnrichedLike {
  noradId: number;
  name: string;
  omm: unknown;
  objectType?: string;
  category?: string;
  regime?: string;
  perigee?: number;
  rcsSize?: string | null;
}

/** Only rocket bodies and debris change the screener's behaviour (hard-body radius, uncertainty class); everything else is a payload / unknown. */
export const screenerObjectType = (t: string | null | undefined): 'rocket_body' | 'debris' | 'unknown' => (t === 'rocket_body' || t === 'debris' ? t : 'unknown');

export function fromEnriched(o: EnrichedLike): SsaObject {
  const out: SsaObject = {
    noradId: o.noradId,
    name: o.name,
    objectType: screenerObjectType(o.objectType ?? o.category),
    rcsSize: o.rcsSize ?? null,
    omm: o.omm as Record<string, unknown>,
  };
  if (o.regime !== undefined) out.regime = o.regime;
  if (o.perigee !== undefined) out.perigee = o.perigee;
  return out;
}

export interface DbCatalogOpts {
  /** ignore element sets older than this many days before the batch time (default 60: the propagation cap of the live app) */
  maxAgeDays?: number;
}

/** Per object the latest element set with epoch <= batchTimeMs (the causal rule), ordered by NORAD id. */
export async function loadCatalogFromDb(pool: Pool, batchTimeMs: number, opts: DbCatalogOpts = {}): Promise<SsaObject[]> {
  const maxAge = opts.maxAgeDays ?? 60;
  const r = await pool.query<{
    norad_id: number; omm: Record<string, unknown>; object_name: string | null; rcs_size: string | null;
    category: string | null; regime: string | null; perigee_km: number | null;
  }>(
    `SELECT u.norad_id, u.omm, d.object_name, d.rcs_size, f.category, f.regime, f.perigee_km
     FROM (
       SELECT DISTINCT ON (norad_id) norad_id, omm FROM omm_updates
       WHERE epoch <= to_timestamp($1::float8 / 1000.0) AND epoch > to_timestamp($1::float8 / 1000.0) - make_interval(days => $2::int)
       ORDER BY norad_id, epoch DESC
     ) u
     LEFT JOIN object_dim d ON d.norad_id = u.norad_id
     LEFT JOIN LATERAL (SELECT category, regime, perigee_km FROM omm_daily o WHERE o.norad_id = u.norad_id ORDER BY o.utc_day DESC LIMIT 1) f ON true
     ORDER BY u.norad_id`,
    [batchTimeMs, maxAge],
  );
  return r.rows.map((x): SsaObject => {
    const o: SsaObject = {
      noradId: x.norad_id,
      name: x.object_name || String(x.omm.OBJECT_NAME ?? ''),
      objectType: screenerObjectType(x.category),
      rcsSize: x.rcs_size,
      omm: x.omm,
    };
    if (x.regime) o.regime = x.regime;
    if (x.perigee_km !== null && x.perigee_km !== undefined) o.perigee = Number(x.perigee_km);
    return o;
  });
}
