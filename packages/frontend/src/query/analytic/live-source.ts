// ============================================================
// Analytic IR v1 — LIVE data source (P1).
//
// The real AnalyticDataSource: catalog fields + SGP4 state + entity vocab,
// behind the same port the fixture implements. Pure tier — imports data/ +
// @orbitwatch/orbital-core + satellite.js only; the ENGINE (SatellitesLayer)
// constructs it with injected accessors, so this file never touches the
// store, workers, or renderers.
//
// State-at-t resolution: when tMs is within BUFFER_TOLERANCE_MS of the
// worker's last propagation, positions/velocities come from the transferred
// buffers (TEME, earth-radii + ER/s — already in the shape orbital-core's
// StateEr wants, no conversion needed), advanced to tMs by r + v·dt. Any other instant falls back to
// on-demand SGP4 via a lazy per-object satrec cache (json2satrec), memoized
// per (object, t) so a timeScan predicate reading several fields at one step
// propagates once. On-demand propagation is gated by the ±60-day window in
// @orbitwatch/orbital-core (outside it → null state).
//
// Physics: state resolution (this file) is the only thing that differs from
// the backend's twin (analytic/providers/sgp4.ts — buffers vs on-demand
// SGP4). Every derived quantity — speed, altitude, sub-point, eclipse,
// elevation/range/observer-darkness/visual-visibility/distance — is computed
// directly in TEME by one shared @orbitwatch/orbital-core createLivePlane()
// instance, so the two adapters can never numerically drift apart.
//
// Known adapter gaps (fields that return null/false on the LIVE universe,
// honest via skip-and-count): jcat/parentJcat (not inlined → descendsFrom is
// always false until a parent index artifact ships), launch.date/lvType/pad/
// success and owner.stateCode/cls (vocab doesn't carry them), and the space-
// weather fields (server-only NOAA SWPC provider). All are listed in
// packages/analytic capability.ts CLIENT_UNSERVED_FIELDS, so the router sends
// programs that read them to the server instead.
// ============================================================

import * as satellite from 'satellite.js';
import type { QueryVocab } from '../../data/query-vocab-client';
import { programLabel, type EnrichedTLEObject } from '@orbitwatch/contracts';
import {
  createLivePlane,
  stateFromKm,
  withinPropagationWindow,
  julianDate,
  semiMajorAxisKmFromMeanMotion,
  type StateEr,
} from '@orbitwatch/orbital-core';
import type { AnalyticDataSource, FieldValue, ResolvedObserver } from '@orbitwatch/analytic';

const MS_PER_YEAR = 365.25 * 86400_000;

/** How far tMs may drift from the worker's propagation timestamp and still use buffers. */
export const BUFFER_TOLERANCE_MS = 8000;

export interface LiveBuffers {
  /** TEME positions in earth-radii, [x,y,z] per object (worker-transferred). */
  positions: Float32Array;
  /** TEME velocities in earth-radii per second. */
  velocities: Float32Array;
  validFlags: Uint8Array;
  /** Sim-time the buffers were propagated at (ms). */
  timestamp: number;
}

export interface LiveSourceDeps {
  catalog: EnrichedTLEObject[];
  /** Latest raw worker buffers, or null before the first propagation. */
  getBuffers: () => LiveBuffers | null;
  /** Installed query vocab (launch/org entity data), or null before it lands. */
  getVocab: () => QueryVocab | null;
  /** Curated naked-eye NORAD set — enables visuallyVisible(); omit → null. */
  getVisualNoradIds?: () => Set<number>;
}

export function createLiveAnalyticSource(deps: LiveSourceDeps): AnalyticDataSource {
  const { catalog } = deps;
  const byNorad = new Map<number, number>();
  catalog.forEach((o, i) => byNorad.set(o.noradId, i));

  // Lazy satrec cache for off-buffer instants (undefined = not built, null = bad elset).
  const satrecs: (satellite.SatRec | null | undefined)[] = new Array(catalog.length);
  // Per-object single-entry memo: the last propagated instant (timeScan-friendly).
  const stateMemo = new Map<number, { t: number; s: StateEr | null }>();

  function omm(i: number): Record<string, unknown> {
    return catalog[i].omm as unknown as Record<string, unknown>;
  }

  function ommNum(i: number, key: string): number | null {
    const v = omm(i)[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function resolveState(i: number, tMs: number): StateEr | null {
    const buf = deps.getBuffers();
    if (buf && Math.abs(tMs - buf.timestamp) <= BUFFER_TOLERANCE_MS) {
      if (!buf.validFlags[i]) return null;
      const i3 = i * 3;
      // Advance the buffered state to the requested instant (r + v·dt, v in ER/s):
      // a stale buffer would otherwise shift a LEO object by up to ~60 km over the
      // tolerance window — more than the WGS84 correction. Error after
      // extrapolation is second-order (~0.3 km at 8 s).
      const dtS = (tMs - buf.timestamp) / 1000;
      const vx = buf.velocities[i3];
      const vy = buf.velocities[i3 + 1];
      const vz = buf.velocities[i3 + 2];
      return {
        r: {
          x: buf.positions[i3] + vx * dtS,
          y: buf.positions[i3 + 1] + vy * dtS,
          z: buf.positions[i3 + 2] + vz * dtS,
        },
        v: { x: vx, y: vy, z: vz },
      };
    }
    const memo = stateMemo.get(i);
    if (memo && memo.t === tMs) return memo.s;

    let rec = satrecs[i];
    if (rec === undefined) {
      try {
        rec = satellite.json2satrec(catalog[i].omm);
      } catch {
        rec = null;
      }
      satrecs[i] = rec;
    }
    let s: StateEr | null = null;
    // Propagation-window guard — the same policy as the SGP4 worker and the
    // server provider (backend analytic/providers/sgp4.ts): never let SDP4's
    // deep-space integrator run far from epoch (the far-time wedge; timeScan
    // steps can land past the validator's timeBinding caps). Out of window →
    // null, the honest "not derivable" value counted in meta.coverage.
    // julianDate(NaN) is NaN, and withinPropagationWindow rejects non-finite,
    // so an Invalid Date instant never reaches the propagator either.
    const jdNow = julianDate(tMs);
    if (rec && withinPropagationWindow(jdNow, rec.jdsatepoch)) {
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
    stateMemo.set(i, { t: tMs, s });
    return s;
  }

  const plane = createLivePlane<number>(resolveState);

  /** Walk the org parent chain to the family root code (bounded). */
  function ownerFamilyRoot(code: string | undefined): string | null {
    if (!code) return null;
    const orgs = deps.getVocab()?.orgs;
    if (!orgs) return code; // no tree data — the code itself is the best answer
    let cur = code;
    for (let hop = 0; hop < 10; hop++) {
      const parent = orgs[cur]?.p;
      if (!parent || !orgs[parent]) return cur;
      cur = parent;
    }
    return cur;
  }

  function getField(i: number, field: string, tMs: number): FieldValue {
    const obj = catalog[i];
    switch (field) {
      // Identity & classification
      case 'noradId': return obj.noradId;
      case 'name': return obj.name;
      case 'cospar': return (omm(i).OBJECT_ID as string | undefined) ?? null;
      case 'objectType': return obj.objectType === 'satellite' ? 'payload' : obj.objectType;
      case 'category': return obj.category;
      case 'regime': return obj.regime;
      case 'status': return obj.status;
      case 'sectors': return obj.sectors;
      case 'purpose': return obj.purpose;
      case 'countryCode': return obj.countryCode || null;
      case 'program': return obj.program ?? null;
      case 'owner': return obj.owner ?? null;
      case 'launchTag': return obj.launchTag ?? null;
      case 'launchDate': return obj.launchDate;
      case 'rcsSize': return obj.rcsSize;
      case 'jcat': case 'parentJcat': case 'operationalStatus': return null; // not inlined (gap)

      // Mean elements (current elset)
      case 'epoch': return obj.epoch;
      case 'period': return obj.period;
      case 'apogeeKm': return obj.apogee;
      case 'perigeeKm': return obj.perigee;
      case 'inclination': return obj.inclination;
      case 'meanMotion': return ommNum(i, 'MEAN_MOTION');
      case 'meanMotionDot': return ommNum(i, 'MEAN_MOTION_DOT');
      case 'meanMotionDdot': return ommNum(i, 'MEAN_MOTION_DDOT');
      case 'bstar': return ommNum(i, 'BSTAR');
      case 'eccentricity': return ommNum(i, 'ECCENTRICITY');
      case 'raOfAscNode': return ommNum(i, 'RA_OF_ASC_NODE');
      case 'argOfPericenter': return ommNum(i, 'ARG_OF_PERICENTER');
      case 'meanAnomaly': return ommNum(i, 'MEAN_ANOMALY');

      // Derived — live plane (speed/altitude/subpoint/eclipse), orbital-core
      case 'speedKmS': case 'altitudeKm': case 'latDeg': case 'lonDeg': case 'eclipsed':
        return plane.field(i, field, tMs);

      // Derived — catalog plane
      case 'meanAltitudeKm': return (obj.apogee + obj.perigee) / 2;
      case 'semiMajorAxisKm': return semiMajorAxisKmFromMeanMotion(ommNum(i, 'MEAN_MOTION'));
      case 'ageYears':
        return obj.launchDate ? (tMs - Date.parse(obj.launchDate)) / MS_PER_YEAR : null;
      case 'launchYear': {
        const y = obj.launchDate ? parseInt(obj.launchDate.slice(0, 4), 10) : NaN;
        return Number.isFinite(y) ? y : null;
      }
      case 'ownerFamily': return ownerFamilyRoot(obj.owner);

      // Dotted join paths (vocab-backed)
      case 'launch.lvFamily':
        return (obj.launchTag && deps.getVocab()?.launches[obj.launchTag]?.[0]) || null;
      case 'launch.siteName':
        return (obj.launchTag && deps.getVocab()?.launches[obj.launchTag]?.[1]) || null;
      case 'owner.name':
        return (obj.owner && deps.getVocab()?.orgs[obj.owner]?.n) || null;
      case 'program.label':
        return obj.program ? programLabel(obj.program) : null;
      case 'launch.date': case 'launch.lvType': case 'launch.pad': case 'launch.success':
      case 'owner.stateCode': case 'owner.cls':
        return null; // vocab doesn't carry these (adapter gap)

      default:
        return null;
    }
  }

  return {
    size: () => catalog.length,
    noradId: (i) => catalog[i].noradId,
    noradToIndex: (id) => byNorad.get(id),
    getField,
    elevationDeg: (i, obs: ResolvedObserver, tMs) => plane.elevationDeg(i, obs, tMs),
    rangeKm: (i, obs: ResolvedObserver, tMs) => plane.rangeKm(i, obs, tMs),
    observerDark: (obs: ResolvedObserver, tMs) => plane.observerDark(obs, tMs),
    visuallyVisible: (i, obs: ResolvedObserver, tMs) => {
      const curated = deps.getVisualNoradIds?.();
      if (!curated) return null;
      return plane.visuallyVisible(i, obs, tMs, curated.has(catalog[i].noradId));
    },
    distToKm: (i, targetNoradId, tMs) => {
      const j = byNorad.get(targetNoradId);
      if (j === undefined) return null;
      return plane.distanceKm(i, j, tMs);
    },
    // parentJcat isn't inlined on the live catalog — honest false until a
    // separation-tree index artifact ships (schema gap, corpus D8 live).
    descendsFrom: () => false,
  };
}
