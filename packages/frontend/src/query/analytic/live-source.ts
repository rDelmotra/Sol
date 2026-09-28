// ============================================================
// Analytic IR v1 — LIVE data source (P1).
//
// The real AnalyticDataSource: catalog fields + SGP4 state + entity vocab +
// orbital/ physics, behind the same port the fixture implements. Pure tier —
// imports data/ + orbital/ + satellite.js only; the ENGINE (SatellitesLayer)
// constructs it with injected accessors, so this file never touches the
// store, workers, or renderers.
//
// State-at-t resolution: when tMs is within BUFFER_TOLERANCE_MS of the
// worker's last propagation, positions/velocities come from the transferred
// buffers (TEME, earth-radii + ER/s — free). Any other instant falls back to
// on-demand SGP4 via a lazy per-object satrec cache (json2satrec), memoized
// per (object, t) so a timeScan predicate reading several fields at one step
// propagates once. On-demand propagation is gated by the ±60-day window in
// orbital/propagation-limits.ts (outside it → null state).
//
// Frame: all internal math is TEME in earth-radii (buffer-native; the eclipse
// umbra test expects ER). Scene-frame helpers (sun direction, observer
// position) are converted scene→TEME via the inverse of frames.ts
// sourceToScene: teme = (s.x, -s.z, s.y). The swap is orthogonal, so dot
// products (elevation, eclipse, darkness) are frame-consistent.
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
import type { EnrichedTLEObject } from '../../data/types';
import type { QueryVocab } from '../../data/query-vocab-client';
import { PROGRAM_LABELS } from '../../data/metadata-types';
import { getGAST, getSunDirection } from '../../orbital/time';
import { getObserverScenePosition } from '../../orbital/coordinates';
import { isEclipsedFromComponents, isObserverInDarkFromComponents } from '../../orbital/lighting';
import { evaluateVisualVisibility } from '../../orbital/visual-visibility';
import { withinPropagationWindow } from '../../orbital/propagation-limits';
import type { AnalyticDataSource, FieldValue, ResolvedObserver } from '@orbitwatch/analytic';

const EARTH_RADIUS_KM = 6371;
const MU_KM3_S2 = 398600.4418;
const MS_PER_YEAR = 365.25 * 86400_000;
const DEG = 180 / Math.PI;

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

interface StateVec {
  px: number; py: number; pz: number;   // TEME, earth-radii
  vx: number; vy: number; vz: number;   // TEME, earth-radii / s
}

export function createLiveAnalyticSource(deps: LiveSourceDeps): AnalyticDataSource {
  const { catalog } = deps;
  const byNorad = new Map<number, number>();
  catalog.forEach((o, i) => byNorad.set(o.noradId, i));

  // Lazy satrec cache for off-buffer instants (undefined = not built, null = bad elset).
  const satrecs: (satellite.SatRec | null | undefined)[] = new Array(catalog.length);
  // Per-object single-entry memo: the last propagated instant (timeScan-friendly).
  const stateMemo = new Map<number, { t: number; s: StateVec | null }>();
  // Per-instant caches shared across the whole catalog scan.
  let sunCache: { t: number; x: number; y: number; z: number } | null = null;
  let obsCache: { t: number; key: string; x: number; y: number; z: number } | null = null;

  function omm(i: number): Record<string, unknown> {
    return catalog[i].omm as unknown as Record<string, unknown>;
  }

  function ommNum(i: number, key: string): number | null {
    const v = omm(i)[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function resolveState(i: number, tMs: number): StateVec | null {
    const buf = deps.getBuffers();
    if (buf && Math.abs(tMs - buf.timestamp) <= BUFFER_TOLERANCE_MS) {
      if (!buf.validFlags[i]) return null;
      const i3 = i * 3;
      return {
        px: buf.positions[i3], py: buf.positions[i3 + 1], pz: buf.positions[i3 + 2],
        vx: buf.velocities[i3], vy: buf.velocities[i3 + 1], vz: buf.velocities[i3 + 2],
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
    let s: StateVec | null = null;
    // Propagation-window guard — the same policy as the SGP4 worker and the
    // server provider (backend analytic/providers/sgp4.ts): never let SDP4's
    // deep-space integrator run far from epoch (the far-time wedge; timeScan
    // steps can land past the validator's timeBinding caps). Out of window →
    // null, the honest "not derivable" value counted in meta.coverage.
    const jdNow = Number.isFinite(tMs) ? satellite.jday(new Date(tMs)) : NaN;
    if (rec && withinPropagationWindow(jdNow, rec.jdsatepoch)) {
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
    stateMemo.set(i, { t: tMs, s });
    return s;
  }

  /** Sun direction in TEME (scene→TEME: teme = (s.x, -s.z, s.y)), cached per instant. */
  function sunTeme(tMs: number): { x: number; y: number; z: number } {
    if (!sunCache || sunCache.t !== tMs) {
      const s = getSunDirection(new Date(tMs));
      sunCache = { t: tMs, x: s.x, y: -s.z, z: s.y };
    }
    return sunCache;
  }

  /** Observer position in TEME earth-radii, cached per (instant, location). */
  function observerTeme(obs: ResolvedObserver, tMs: number): { x: number; y: number; z: number } {
    const key = `${obs.latDeg},${obs.lonDeg},${obs.altKm ?? 0}`;
    if (!obsCache || obsCache.t !== tMs || obsCache.key !== key) {
      const p = getObserverScenePosition(obs.latDeg, obs.lonDeg, obs.altKm ?? 0, new Date(tMs));
      obsCache = { t: tMs, key, x: p.x, y: -p.z, z: p.y };
    }
    return obsCache;
  }

  function elevationSinAndRange(i: number, obs: ResolvedObserver, tMs: number): { sinE: number; rangeKm: number } | null {
    const s = resolveState(i, tMs);
    if (!s) return null;
    const o = observerTeme(obs, tMs);
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

  function eclipsed(i: number, tMs: number): boolean | null {
    const s = resolveState(i, tMs);
    if (!s) return null;
    const sun = sunTeme(tMs);
    return isEclipsedFromComponents(s.px, s.py, s.pz, sun.x, sun.y, sun.z);
  }

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

      // Derived — live plane
      case 'speedKmS': {
        const s = resolveState(i, tMs);
        return s ? Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz) * EARTH_RADIUS_KM : null;
      }
      case 'altitudeKm': {
        const s = resolveState(i, tMs);
        return s ? (Math.sqrt(s.px * s.px + s.py * s.py + s.pz * s.pz) - 1) * EARTH_RADIUS_KM : null;
      }
      case 'latDeg': case 'lonDeg': {
        const s = resolveState(i, tMs);
        if (!s) return null;
        const theta = getGAST(new Date(tMs));
        // TEME → ECEF: rotate by -GAST about the pole.
        const ex = Math.cos(theta) * s.px + Math.sin(theta) * s.py;
        const ey = -Math.sin(theta) * s.px + Math.cos(theta) * s.py;
        if (field === 'lonDeg') return Math.atan2(ey, ex) * DEG;
        const r = Math.sqrt(s.px * s.px + s.py * s.py + s.pz * s.pz);
        return r === 0 ? null : Math.asin(s.pz / r) * DEG; // geocentric latitude
      }
      case 'eclipsed': return eclipsed(i, tMs);

      // Derived — catalog plane
      case 'meanAltitudeKm': return (obj.apogee + obj.perigee) / 2;
      case 'semiMajorAxisKm': {
        const n = ommNum(i, 'MEAN_MOTION');
        if (!n || n <= 0) return null;
        const radPerSec = (n * 2 * Math.PI) / 86400;
        return Math.cbrt(MU_KM3_S2 / (radPerSec * radPerSec));
      }
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
        return obj.program ? PROGRAM_LABELS[obj.program] ?? obj.program : null;
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
    elevationDeg: (i, obs, tMs) => {
      const er = elevationSinAndRange(i, obs, tMs);
      return er ? Math.asin(Math.max(-1, Math.min(1, er.sinE))) * DEG : null;
    },
    rangeKm: (i, obs, tMs) => elevationSinAndRange(i, obs, tMs)?.rangeKm ?? null,
    observerDark: (obs, tMs) => {
      const o = observerTeme(obs, tMs);
      const sun = sunTeme(tMs);
      return isObserverInDarkFromComponents(o.x, o.y, o.z, sun.x, sun.y, sun.z);
    },
    visuallyVisible: (i, obs, tMs) => {
      const curated = deps.getVisualNoradIds?.();
      if (!curated) return null;
      const er = elevationSinAndRange(i, obs, tMs);
      const ecl = eclipsed(i, tMs);
      if (!er || ecl === null) return null;
      const o = observerTeme(obs, tMs);
      const sun = sunTeme(tMs);
      return evaluateVisualVisibility({
        isCurated: curated.has(catalog[i].noradId),
        elevationSin: er.sinE,
        rangeKm: er.rangeKm,
        observerDark: isObserverInDarkFromComponents(o.x, o.y, o.z, sun.x, sun.y, sun.z),
        satelliteEclipsed: ecl,
      }).visible;
    },
    distToKm: (i, targetNoradId, tMs) => {
      const j = byNorad.get(targetNoradId);
      if (j === undefined) return null;
      const a = resolveState(i, tMs);
      const b = resolveState(j, tMs);
      if (!a || !b) return null;
      const dx = a.px - b.px;
      const dy = a.py - b.py;
      const dz = a.pz - b.pz;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) * EARTH_RADIUS_KM;
    },
    // parentJcat isn't inlined on the live catalog — honest false until a
    // separation-tree index artifact ships (schema gap, corpus D8 live).
    descendsFrom: () => false,
  };
}
