// ============================================================
// P3 S3 Part C — SGP4 provider: the LIVE plane, server-side.
// Spec: my_plans/marvin/p3/S3_sgp4_provider_astro.md
//
// Structure mirrors packages/frontend/src/query/analytic/live-source.ts's
// state machinery, minus the worker-buffer fast path — the server has no
// worker buffers, so every resolve is on-demand SGP4 (satellite.js), guarded
// by the propagation-window cap (astro.ts MAX_TSINCE_MIN) against the SDP4
// deep-space resonance wedge.
//
// PERF: a full-catalog scan touching a live field = ~32k on-demand
// propagations ≈ 0.5–1.5 s Node single-thread, memoized per (object, instant).
// That is the accepted v1 cost of server-side liveness; measure in S7 — if it
// is worse in practice, the escape hatches (persistent satrec pool primed at
// boot / worker_threads) are P4-adjacent work, NOT scope creep here.
// ============================================================

import * as satellite from 'satellite.js';
import type { FieldValue, ResolvedObserver } from '@orbitwatch/analytic';
import { readCache, readVersion, readVisualCache } from '../../cache/file-cache.js';
import type { EnrichedTLEObject, VersionInfo } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import type { FieldProvider } from '../types.js';
import { createVersionGuard } from './version-guard.js';
import {
  getGAST,
  sunDirTeme,
  observerTeme as astroObserverTeme,
  isEclipsedFromComponents,
  isObserverInDarkFromComponents,
  evaluateVisualVisibility,
  toJulianDate,
  MAX_TSINCE_MIN,
} from '../astro.js';

const EARTH_RADIUS_KM = 6371;
const DEG = 180 / Math.PI;
const MINUTES_PER_DAY = 1440;

export interface Sgp4ProviderDeps {
  readCatalog?: () => EnrichedTLEObject[] | null;
  readVersion?: () => VersionInfo | null;
  /** Curated naked-eye NORAD set — omit/null disables visuallyVisible() (honest null). */
  getVisualNoradIds?: () => Set<number> | null;
  /** Test seam: how long the curated visual list is cached before re-reading. */
  visualIdsTtlMs?: number;
}

interface StateVec {
  px: number; py: number; pz: number; // TEME, earth-radii
  vx: number; vy: number; vz: number; // TEME, earth-radii / s
}

const SGP4_FIELDS: readonly string[] = ['speedKmS', 'altitudeKm', 'latDeg', 'lonDeg', 'eclipsed'];

function defaultGetVisualNoradIds(): Set<number> | null {
  const cache = readVisualCache();
  return cache ? new Set(cache.ids) : null;
}

export function createSgp4Provider(deps: Sgp4ProviderDeps = {}): FieldProvider {
  const readCatalogFn = deps.readCatalog ?? readCache;
  const readVersionFn = deps.readVersion ?? readVersion;
  const getVisualNoradIdsFn = deps.getVisualNoradIds ?? defaultGetVisualNoradIds;
  const guard = createVersionGuard(readVersionFn);

  let catalog: EnrichedTLEObject[] = [];
  let byNorad = new Map<number, number>();
  // Lazy satrec cache, keyed by noradId (providers are noradId-keyed — only
  // server-source.ts knows index<->noradId). undefined = not built yet.
  let satrecs = new Map<number, satellite.SatRec | null>();
  // Per-object single-entry memo — a filter reading altitudeKm + speedKmS at
  // one instant propagates once; timeScan steps stay linear.
  let stateMemo = new Map<number, { t: number; s: StateVec | null }>();
  // Per-instant caches shared across a whole catalog scan.
  let sunCache: { t: number; x: number; y: number; z: number } | null = null;
  let obsCache: { t: number; key: string; x: number; y: number; z: number } | null = null;
  // Curated visual-list cache — time-bounded, NOT a one-shot memo: the file is
  // cron-refreshed (8h TTL) and may not exist yet at first call (boot race), so
  // a forever-memo would serve stale membership or pin the feature off until
  // restart. 60s TTL = at most one small disk read per minute across a
  // full-catalog visuallyVisible scan, while still picking up cron writes.
  const visualIdsTtlMs = deps.visualIdsTtlMs ?? 60_000;
  let visualIds: Set<number> | null = null;
  let visualIdsReadMs = -Infinity;

  function currentVisualIds(): Set<number> | null {
    const now = Date.now();
    if (now - visualIdsReadMs >= visualIdsTtlMs) {
      visualIds = getVisualNoradIdsFn();
      visualIdsReadMs = now;
    }
    return visualIds;
  }

  function ensureFresh(): void {
    if (!guard.shouldReload()) return;
    catalog = readCatalogFn() ?? [];
    const idx = new Map<number, number>();
    catalog.forEach((o, i) => idx.set(o.noradId, i));
    byNorad = idx;
    // Version changed under us — cached satrecs/memo reference the old elset.
    satrecs = new Map();
    stateMemo = new Map();
    logger.info(`SGP4 provider (analytic): ${catalog.length} objects loaded, version=${guard.currentVersion() ?? 'unknown'}`);
  }

  function resolveState(noradId: number, tMs: number): StateVec | null {
    const memo = stateMemo.get(noradId);
    if (memo && memo.t === tMs) return memo.s;

    let rec = satrecs.get(noradId);
    if (rec === undefined) {
      const i = byNorad.get(noradId);
      if (i === undefined) {
        satrecs.set(noradId, null);
        rec = null;
      } else {
        try {
          rec = satellite.json2satrec(catalog[i].omm);
        } catch {
          rec = null;
        }
        satrecs.set(noradId, rec);
      }
    }

    let s: StateVec | null = null;
    if (rec) {
      // Propagation-window guard: defense-in-depth behind the validator's time
      // caps (timeScan can step past them) — the SDP4 deep-space wedge protection.
      const jdNow = toJulianDate(tMs);
      const tsinceMin = (jdNow - rec.jdsatepoch) * MINUTES_PER_DAY;
      if (Number.isFinite(tsinceMin) && Math.abs(tsinceMin) <= MAX_TSINCE_MIN) {
        try {
          const r = satellite.propagate(rec, new Date(tMs));
          const p = r?.position;
          const v = r?.velocity;
          if (p && v && typeof p !== 'boolean' && typeof v !== 'boolean' && Number.isFinite(p.x)) {
            s = {
              px: p.x / EARTH_RADIUS_KM, py: p.y / EARTH_RADIUS_KM, pz: p.z / EARTH_RADIUS_KM,
              vx: v.x / EARTH_RADIUS_KM, vy: v.y / EARTH_RADIUS_KM, vz: v.z / EARTH_RADIUS_KM,
            };
          }
        } catch {
          s = null;
        }
      }
    }
    stateMemo.set(noradId, { t: tMs, s });
    return s;
  }

  function sunTemeCached(tMs: number): { x: number; y: number; z: number } {
    if (!sunCache || sunCache.t !== tMs) {
      const s = sunDirTeme(tMs);
      sunCache = { t: tMs, x: s.x, y: s.y, z: s.z };
    }
    return sunCache;
  }

  function observerTemeCached(obs: ResolvedObserver, tMs: number): { x: number; y: number; z: number } {
    const key = `${obs.latDeg},${obs.lonDeg},${obs.altKm ?? 0}`;
    if (!obsCache || obsCache.t !== tMs || obsCache.key !== key) {
      const p = astroObserverTeme(obs.latDeg, obs.lonDeg, obs.altKm ?? 0, tMs);
      obsCache = { t: tMs, key, x: p.x, y: p.y, z: p.z };
    }
    return obsCache;
  }

  function elevationSinAndRange(
    noradId: number,
    obs: ResolvedObserver,
    tMs: number,
  ): { sinE: number; rangeKm: number } | null {
    const s = resolveState(noradId, tMs);
    if (!s) return null;
    const o = observerTemeCached(obs, tMs);
    const vx = s.px - o.x;
    const vy = s.py - o.y;
    const vz = s.pz - o.z;
    const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (dist === 0) return null;
    const oLen = Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z);
    if (oLen === 0) return null;
    const sinE = (vx * o.x + vy * o.y + vz * o.z) / (dist * oLen);
    return { sinE, rangeKm: dist * EARTH_RADIUS_KM };
  }

  function eclipsed(noradId: number, tMs: number): boolean | null {
    const s = resolveState(noradId, tMs);
    if (!s) return null;
    const sun = sunTemeCached(tMs);
    return isEclipsedFromComponents(s.px, s.py, s.pz, sun.x, sun.y, sun.z);
  }

  function getField(noradId: number, field: string, tMs: number): FieldValue {
    ensureFresh();
    switch (field) {
      case 'speedKmS': {
        const s = resolveState(noradId, tMs);
        return s ? Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz) * EARTH_RADIUS_KM : null;
      }
      case 'altitudeKm': {
        const s = resolveState(noradId, tMs);
        return s ? (Math.sqrt(s.px * s.px + s.py * s.py + s.pz * s.pz) - 1) * EARTH_RADIUS_KM : null;
      }
      case 'latDeg': case 'lonDeg': {
        const s = resolveState(noradId, tMs);
        if (!s) return null;
        const theta = getGAST(tMs);
        // TEME -> ECEF: rotate by -GAST about the pole.
        const ex = Math.cos(theta) * s.px + Math.sin(theta) * s.py;
        const ey = -Math.sin(theta) * s.px + Math.cos(theta) * s.py;
        if (field === 'lonDeg') return Math.atan2(ey, ex) * DEG;
        const r = Math.sqrt(s.px * s.px + s.py * s.py + s.pz * s.pz);
        return r === 0 ? null : Math.asin(s.pz / r) * DEG; // geocentric latitude
      }
      case 'eclipsed': return eclipsed(noradId, tMs);
      default: return null;
    }
  }

  function elevationDeg(noradId: number, obs: ResolvedObserver, tMs: number): number | null {
    ensureFresh();
    const er = elevationSinAndRange(noradId, obs, tMs);
    return er ? Math.asin(Math.max(-1, Math.min(1, er.sinE))) * DEG : null;
  }

  function rangeKm(noradId: number, obs: ResolvedObserver, tMs: number): number | null {
    ensureFresh();
    return elevationSinAndRange(noradId, obs, tMs)?.rangeKm ?? null;
  }

  function observerDark(obs: ResolvedObserver, tMs: number): boolean | null {
    ensureFresh();
    const o = observerTemeCached(obs, tMs);
    const sun = sunTemeCached(tMs);
    return isObserverInDarkFromComponents(o.x, o.y, o.z, sun.x, sun.y, sun.z);
  }

  function visuallyVisible(noradId: number, obs: ResolvedObserver, tMs: number): boolean | null {
    ensureFresh();
    const curated = currentVisualIds();
    if (!curated) return null;

    const er = elevationSinAndRange(noradId, obs, tMs);
    const ecl = eclipsed(noradId, tMs);
    if (!er || ecl === null) return null;
    const o = observerTemeCached(obs, tMs);
    const sun = sunTemeCached(tMs);
    return evaluateVisualVisibility({
      isCurated: curated.has(noradId),
      elevationSin: er.sinE,
      rangeKm: er.rangeKm,
      observerDark: isObserverInDarkFromComponents(o.x, o.y, o.z, sun.x, sun.y, sun.z),
      satelliteEclipsed: ecl,
    }).visible;
  }

  function distToKm(noradId: number, targetNoradId: number, tMs: number): number | null {
    ensureFresh();
    const a = resolveState(noradId, tMs);
    const b = resolveState(targetNoradId, tMs);
    if (!a || !b) return null;
    const dx = a.px - b.px;
    const dy = a.py - b.py;
    const dz = a.pz - b.pz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) * EARTH_RADIUS_KM;
  }

  return {
    id: 'sgp4',
    fields: SGP4_FIELDS,
    fns: ['elevationDeg', 'rangeKm', 'observerDark', 'visuallyVisible', 'distToKm'],
    getField,
    elevationDeg,
    rangeKm,
    observerDark,
    visuallyVisible,
    distToKm,
  };
}
