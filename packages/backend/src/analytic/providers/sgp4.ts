// ============================================================
// P3 S3 Part C — SGP4 provider: the LIVE plane, server-side.
// Spec: my_plans/marvin/p3/S3_sgp4_provider_astro.md
//
// This file resolves state ONLY: catalog/version guard, lazy satrec cache,
// per-object state memo, and the propagation-window guard (against the SDP4
// deep-space resonance wedge). Every derived physics quantity — speed,
// altitude, sub-point, eclipse, elevation/range/observer-darkness/visual-
// visibility/distance — is delegated to a single createLivePlane() instance
// from @orbitwatch/orbital-core, the same live-plane math the frontend's
// query/analytic/live-source.ts drives from worker buffers instead of
// on-demand SGP4.
//
// PERF: a full-catalog scan touching a live field = ~32k on-demand
// propagations ≈ 0.5–1.5 s Node single-thread, memoized per (object, instant).
// That is the accepted v1 cost of server-side liveness; measure in S7 — if it
// is worse in practice, the escape hatches (persistent satrec pool primed at
// boot / worker_threads) are P4-adjacent work, NOT scope creep here.
// ============================================================

import * as satellite from 'satellite.js';
import type { FieldValue, ResolvedObserver } from '@orbitwatch/analytic';
import {
  createLivePlane,
  stateFromKm,
  LIVE_PLANE_FIELDS,
  withinPropagationWindow,
  julianDate,
  type StateEr,
} from '@orbitwatch/orbital-core';
import { readCache, readVersion, readVisualCache } from '../../cache/file-cache.js';
import type { EnrichedTLEObject, VersionInfo } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import type { FieldProvider } from '../types.js';
import { createVersionGuard } from './version-guard.js';

export interface Sgp4ProviderDeps {
  readCatalog?: () => EnrichedTLEObject[] | null;
  readVersion?: () => VersionInfo | null;
  /** Curated naked-eye NORAD set — omit/null disables visuallyVisible() (honest null). */
  getVisualNoradIds?: () => Set<number> | null;
  /** Test seam: how long the curated visual list is cached before re-reading. */
  visualIdsTtlMs?: number;
}

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
  let stateMemo = new Map<number, { t: number; s: StateEr | null }>();
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

  function resolveState(noradId: number, tMs: number): StateEr | null {
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

    let s: StateEr | null = null;
    if (rec) {
      // Propagation-window guard: defense-in-depth behind the validator's time
      // caps (timeScan can step past them) — the SDP4 deep-space wedge protection.
      // withinPropagationWindow rejects non-finite (e.g. NaN epoch) too.
      const jdNow = julianDate(tMs);
      if (withinPropagationWindow(jdNow, rec.jdsatepoch)) {
        try {
          const r = satellite.propagate(rec, new Date(tMs));
          const p = r?.position;
          const v = r?.velocity;
          if (p && v && typeof p !== 'boolean' && typeof v !== 'boolean' && Number.isFinite(p.x)) {
            s = stateFromKm({ x: p.x, y: p.y, z: p.z }, { x: v.x, y: v.y, z: v.z });
          }
        } catch {
          s = null;
        }
      }
    }
    stateMemo.set(noradId, { t: tMs, s });
    return s;
  }

  const plane = createLivePlane<number>(resolveState);

  function getField(noradId: number, field: string, tMs: number): FieldValue {
    ensureFresh();
    return plane.field(noradId, field, tMs);
  }

  function elevationDeg(noradId: number, obs: ResolvedObserver, tMs: number): number | null {
    ensureFresh();
    return plane.elevationDeg(noradId, obs, tMs);
  }

  function rangeKm(noradId: number, obs: ResolvedObserver, tMs: number): number | null {
    ensureFresh();
    return plane.rangeKm(noradId, obs, tMs);
  }

  function observerDark(obs: ResolvedObserver, tMs: number): boolean | null {
    ensureFresh();
    return plane.observerDark(obs, tMs);
  }

  function visuallyVisible(noradId: number, obs: ResolvedObserver, tMs: number): boolean | null {
    ensureFresh();
    const curated = currentVisualIds();
    if (!curated) return null;
    return plane.visuallyVisible(noradId, obs, tMs, curated.has(noradId));
  }

  function distToKm(noradId: number, targetNoradId: number, tMs: number): number | null {
    ensureFresh();
    return plane.distanceKm(noradId, targetNoradId, tMs);
  }

  return {
    id: 'sgp4',
    fields: LIVE_PLANE_FIELDS,
    fns: ['elevationDeg', 'rangeKm', 'observerDark', 'visuallyVisible', 'distToKm'],
    getField,
    elevationDeg,
    rangeKm,
    observerDark,
    visuallyVisible,
    distToKm,
  };
}
