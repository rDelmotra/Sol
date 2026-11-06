// ============================================================
// Replay catalog shaping — pure (no fetch, no store).
//
//   toEnrichedObject()   one /api/history/catalog object → the EnrichedTLEObject the
//                        render plane already consumes (period / perigee / apogee /
//                        regime from the elements, launch tag from the designator).
//   buildReplayResult()  a whole day → TleCatalogResult (the same shape the live
//                        bootstrap produces) with the SGP propagator flag carried on
//                        the TLE inputs, plus the era's accuracy.
//   stableOrder()        reorder the next day's objects so every object that was
//                        already loaded keeps its slot (index) where possible: the
//                        render buffers are index-addressed, so a day swap that keeps
//                        indices is visually continuous before the first new snap.
//   fragmentIds()        NORAD ids of a launch's pieces (+ parent) in a catalog.
// ============================================================

import type { EnrichedTLEObject, ObjectType, OMMJsonObject, OrbitalRegime } from '@orbitwatch/contracts';
import { semiMajorAxisKmFromMeanMotion, MS_PER_DAY } from '@orbitwatch/orbital-core';
import { buildCatalogResult, type TleCatalogResult } from './tle-client';
import type { HistoryAccuracy, HistoryCatalogObject, HistoryCatalogResponse, HistoryOmm } from './replay-types';

/** Equatorial radius used for perigee / apogee heights, km (WGS-72, as the element sets). */
const RE_KM = 6378.135;

/** Numeric OMM fields: normalized to numbers so both the WASM parser and satellite.js accept them. */
const NUMERIC_OMM_FIELDS = [
  'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY',
  'EPHEMERIS_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
] as const;

/** OMM with numeric fields as numbers and a zoneless EPOCH (the WASM parser rejects a trailing 'Z'). */
export function normalizeOmm(omm: HistoryOmm): OMMJsonObject {
  const out: Record<string, unknown> = { ...omm };
  for (const k of NUMERIC_OMM_FIELDS) {
    const v = Number(omm[k]);
    out[k] = Number.isFinite(v) ? v : 0;
  }
  const ep = String(omm.EPOCH ?? '');
  out.EPOCH = ep.endsWith('Z') ? ep.slice(0, -1) : ep;
  out.CLASSIFICATION_TYPE = omm.CLASSIFICATION_TYPE || 'U';
  out.OBJECT_ID = omm.OBJECT_ID ?? '';
  out.OBJECT_NAME = omm.OBJECT_NAME ?? '';
  return out as unknown as OMMJsonObject;
}

/** Space-Track / SATCAT object type strings (and the wire spelling) → wire ObjectType. */
export function normalizeObjectType(raw: string | null | undefined, name = ''): ObjectType {
  const t = (raw ?? '').trim().toUpperCase();
  if (t === 'PAYLOAD' || t === 'PAY' || t === 'P' || t === 'SATELLITE') return 'satellite';
  if (t === 'ROCKET BODY' || t === 'ROCKET_BODY' || t === 'R/B' || t === 'R') return 'rocket_body';
  if (t === 'DEBRIS' || t === 'DEB' || t === 'D') return 'debris';
  // No usable type: the catalog name convention ("... R/B", "... DEB").
  const n = name.toUpperCase();
  if (/\bR\/B\b/.test(n)) return 'rocket_body';
  if (/\bDEB\b/.test(n)) return 'debris';
  return 'unknown';
}

/** Regime from period (min) and eccentricity — the backend classifier's thresholds. */
export function regimeOf(periodMin: number, ecc: number): OrbitalRegime {
  if (ecc >= 0.25) return 'HEO';
  if (periodMin < 128) return 'LEO';
  if (periodMin >= 1380 && periodMin <= 1500 && ecc < 0.1) return 'GEO';
  if (periodMin >= 128 && periodMin < 1380) return 'MEO';
  return 'OTHER';
}

const DESIGNATOR_RE = /^((?:19|20)\d{2}-\d{3})/;

/** Launch designator ("1998-067A" → "1998-067"); null when not COSPAR-shaped. */
export function launchOfDesignator(designator: string | null | undefined): string | null {
  const m = DESIGNATOR_RE.exec((designator ?? '').trim());
  return m ? m[1] : null;
}

/** One replay catalog object as the render plane's EnrichedTLEObject. */
export function toEnrichedObject(o: HistoryCatalogObject): EnrichedTLEObject {
  const omm = normalizeOmm(o.omm);
  const mm = Number(omm.MEAN_MOTION);
  const ecc = Number(omm.ECCENTRICITY);
  const a = semiMajorAxisKmFromMeanMotion(mm);
  const period = mm > 0 ? 1440 / mm : 0;
  const objectType = normalizeObjectType(o.objectType, o.name);
  const designator = o.intlDesignator ?? String(omm.OBJECT_ID ?? '');
  const launchTag = launchOfDesignator(designator);
  const epochRaw = String(omm.EPOCH);
  const out: EnrichedTLEObject = {
    noradId: o.noradId,
    name: o.name || String(omm.OBJECT_NAME ?? '') || String(o.noradId),
    omm,
    objectType,
    // Operational status of a historical object is not known: payloads go to 'unknown'.
    category: objectType === 'satellite' ? 'unknown' : objectType,
    regime: period > 0 ? regimeOf(period, ecc) : 'OTHER',
    countryCode: '',
    launchDate: o.launchDate,
    period,
    apogee: a !== null ? a * (1 + ecc) - RE_KM : 0,
    perigee: a !== null ? a * (1 - ecc) - RE_KM : 0,
    inclination: Number(omm.INCLINATION),
    rcsSize: null,
    epoch: epochRaw.endsWith('Z') ? epochRaw : `${epochRaw}Z`,
    sectors: [],
    purpose: 'other',
    // As of the replayed day the object is in orbit (decayed objects are not in the day's catalog).
    status: 'in_orbit',
  };
  if (launchTag) out.launchTag = launchTag;
  return out;
}

/**
 * Propagation window for replay catalogs, minutes from each set's epoch. Early-era
 * catalogs keep sets up to 93 days old (1963 staleness window); live keeps 60 days.
 */
export const REPLAY_MAX_TSINCE_MIN = 100 * (MS_PER_DAY / 60_000);

/** What the timeline controller installs for a replay day. */
export interface ReplayDayResult {
  day: string;
  result: TleCatalogResult;
  accuracy: HistoryAccuracy | null;
  /** Objects propagated with the original SGP model. */
  sgpCount: number;
}

/**
 * A replay day → TleCatalogResult. `order` (optional) is the slot order of the
 * previous catalog (see stableOrder); the TLE inputs carry `propagator: 'sgp'`
 * for the sets the worker must propagate with SGP.
 */
export function buildReplayResult(resp: HistoryCatalogResponse, prev?: readonly { noradId: number }[]): ReplayDayResult {
  const objects = prev && prev.length > 0 ? stableOrder(prev, resp.objects) : resp.objects;
  const enriched = objects.map(toEnrichedObject);
  const result = buildCatalogResult(enriched);
  let sgpCount = 0;
  for (let i = 0; i < objects.length; i++) {
    if (objects[i].propagator === 'sgp') {
      result.tles[i].propagator = 'sgp';
      sgpCount++;
    }
  }
  return { day: resp.day, result, accuracy: resp.accuracy ?? null, sgpCount };
}

/**
 * Order `next` so objects present in `prev` keep their index wherever it exists in
 * the new array. Slots freed by objects that left (decay / no longer tracked) are
 * taken by new objects; the rest are appended. Only when the catalog shrinks do
 * survivors beyond the new length move (into the free slots). Pure, O(n).
 */
export function stableOrder<T extends { noradId: number }>(prev: readonly { noradId: number }[], next: readonly T[]): T[] {
  const n = next.length;
  const nextById = new Map<number, T>();
  for (const o of next) nextById.set(o.noradId, o);
  const out: (T | undefined)[] = new Array(n);
  const placed = new Set<number>();
  const movers: T[] = [];
  for (let i = 0; i < prev.length; i++) {
    const o = nextById.get(prev[i].noradId);
    if (!o || placed.has(o.noradId)) continue;
    placed.add(o.noradId);
    if (i < n) out[i] = o;
    else movers.push(o);
  }
  // Survivors that no longer fit first (they keep identity, just move), then new objects in their own order.
  const fill = movers.concat(next.filter((o) => !placed.has(o.noradId)));
  let k = 0;
  for (let i = 0; i < n && k < fill.length; i++) {
    if (out[i] === undefined) out[i] = fill[k++];
  }
  return out as T[];
}

/** NORAD ids of every piece of the `launches` in `catalog`, plus the parents when present. */
export function fragmentIds(
  catalog: readonly EnrichedTLEObject[],
  launches: readonly string[],
  parentNorads: readonly number[] = [],
): Set<number> {
  const ls = new Set(launches);
  const ps = new Set(parentNorads);
  const ids = new Set<number>();
  for (const o of catalog) {
    if ((o.launchTag !== undefined && ls.has(o.launchTag)) || ps.has(o.noradId)) ids.add(o.noradId);
  }
  return ids;
}

// ── UTC day arithmetic ──────────────────────────────────────────────────────

/** 'YYYY-MM-DD' + n days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Clamp a 'YYYY-MM-DD' into [first, last] (lexicographic == chronological). */
export function clampDay(day: string, first: string, last: string): string {
  return day < first ? first : day > last ? last : day;
}
