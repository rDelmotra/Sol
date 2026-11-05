// ============================================================
// Encounter evaluation (ported from scripts/starmap/forward-lib.ts, S6 path): hard-body radius, covariance floor, the
// "manoeuvrable" label, the Pc of one encounter, and the match of encounters between runs. The 2D Foster maths is in
// @orbitwatch/orbital-core (collision.ts).
// ============================================================
import * as satellite from 'satellite.js';
import { ricBasis, toRic, covFromRic, addSym3, encounterGeometry, pcFoster, pcMax, principalAxes, sgpInit, sgpPropagate, sgpElementsFromOmm, type SgpRecord } from '@orbitwatch/orbital-core';
import type { Encounter, SsaObject, Vec3 } from './types.js';
import { defaultModel, sigmaRic, type UncertaintyModel } from './uncertainty.js';

export const DAY_MS = 86_400_000;
const MS_PER_DAY = 86_400_000;
const JD_UNIX_EPOCH = 2440587.5;

// ---------------- element sets ----------------
export type SatRec = ReturnType<typeof satellite.json2satrec>;
/**
 * Which model propagates an element set. 'sgp4' (satellite.js) is the default and the only one production uses. 'sgp' is the
 * original SGP of Spacetrack Report #3 (orbital-core sgp.ts) for the history backfill's pre-1980 sets without B*, whose drag lives
 * in MEAN_MOTION_DOT (see src/ssa/history/propagator-policy.ts).
 */
export type PropagatorKind = 'sgp4' | 'sgp';
/** satrec is always built (epoch, validity); `sgp` is set only for kind 'sgp' and then replaces satellite.sgp4 in propagateAt. */
export interface Prop { satrec: SatRec; epochMs: number; sgp?: SgpRecord }

/** Build a propagator; null if the elements are unusable. `kind` defaults to SGP4. */
export function makeProp(omm: unknown, kind?: PropagatorKind): Prop | null {
  try {
    const satrec = satellite.json2satrec(omm as Parameters<typeof satellite.json2satrec>[0]);
    if (satrec.error) return null;
    const epochMs = (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY;
    if (!Number.isFinite(epochMs)) return null;
    if (kind === 'sgp') {
      const sgp = sgpInit(sgpElementsFromOmm(omm as Record<string, unknown>));
      return sgp ? { satrec, epochMs, sgp } : null;
    }
    return { satrec, epochMs };
  } catch {
    return null;
  }
}

interface Xyz { x: number; y: number; z: number }
/** satellite.sgp4's result shape (position / velocity), which callers already read */
export type PosVel = { position: Xyz; velocity: Xyz } | null;
/** Position / velocity (TEME km, km/s) at `tsinceMin` minutes from the epoch, by the Prop's model: exactly satellite.sgp4 unless the Prop is SGP. */
export function propagateAt(p: Prop, tsinceMin: number): PosVel {
  if (!p.sgp) return satellite.sgp4(p.satrec, tsinceMin);
  const s = sgpPropagate(p.sgp, tsinceMin);
  if (!s) return null;
  return { position: { x: s.position[0], y: s.position[1], z: s.position[2] }, velocity: { x: s.velocity[0], y: s.velocity[1], z: s.velocity[2] } };
}

export const epochMsOf = (omm: Record<string, unknown>): number => {
  const s = String(omm.EPOCH);
  return Date.parse(s.endsWith('Z') ? s : s + 'Z');
};

/** Identical-element-set key (objects that sit on top of each other: the ISS stack etc.). */
export function elsetKey(omm: Record<string, unknown>): string {
  return [omm.EPOCH, omm.MEAN_MOTION, omm.ECCENTRICITY, omm.INCLINATION, omm.RA_OF_ASC_NODE, omm.ARG_OF_PERICENTER, omm.MEAN_ANOMALY, omm.BSTAR].join('|');
}
/** Group id per object index for identical element sets (-1 = unique). */
export function identicalGroups(objs: Array<{ omm: Record<string, unknown> }>): { group: Int32Array; groups: number[][] } {
  const group = new Int32Array(objs.length).fill(-1);
  const by = new Map<string, number[]>();
  objs.forEach((o, i) => { const k = elsetKey(o.omm); (by.get(k) ?? by.set(k, []).get(k)!).push(i); });
  const groups: number[][] = [];
  for (const g of by.values()) if (g.length > 1) { g.forEach((i) => (group[i] = groups.length)); groups.push(g); }
  return { group, groups };
}

/**
 * Causal rule: per object the latest element set whose epoch is at or before `batchTimeMs`. Sets after the batch time (the future
 * of the batch) and sets with an unparseable epoch are ignored; an object with no earlier set is left out. Objects keep the order
 * in which they first appear in `catalog`.
 */
export function causalSelect(catalog: SsaObject[], batchTimeMs: number): { objs: SsaObject[]; noEarlierSet: number } {
  const slot = new Map<number, number>(); // noradId -> index in `out`
  const out: Array<{ o: SsaObject; ep: number }> = [];
  const ids = new Set<number>();
  for (const o of catalog) {
    ids.add(o.noradId);
    const ep = epochMsOf(o.omm);
    if (!(ep <= batchTimeMs)) continue;
    const k = slot.get(o.noradId);
    if (k === undefined) { slot.set(o.noradId, out.length); out.push({ o, ep }); } else if (ep > out[k]!.ep) out[k] = { o, ep };
  }
  return { objs: out.map((x) => x.o), noEarlierSet: ids.size - out.length };
}

// ---------------- hard-body radius ----------------
/**
 * Hard-body radius of ONE object in km (the combined radius of a pair is the sum). A sphere that encloses the whole body
 * including panels.
 *   payload / unknown : LARGE 3 m, MEDIUM 1 m, SMALL 0.3 m, no size 2 m
 *   rocket body       : LARGE 5 m, MEDIUM 2 m, no size 3 m
 *   debris            : LARGE 1 m, MEDIUM 0.3 m, SMALL 0.05 m, no size 0.3 m
 *   space stations    : ISS (and its docked stack) 55 m, Tiangong (CSS) stack 25 m
 */
export function hardBodyRadiusKm(o: { noradId: number; name: string; objectType?: string; rcsSize?: string | null }): number {
  if (o.noradId === 25544 || /^ISS\b/.test(o.name)) return 0.055;
  if (/^CSS\b/.test(o.name)) return 0.025;
  const size = o.rcsSize ?? null;
  const t = o.objectType ?? 'unknown';
  const m = t === 'rocket_body' ? (size === 'LARGE' ? 5 : size === 'MEDIUM' ? 2 : 3) : t === 'debris' ? (size === 'LARGE' ? 1 : size === 'MEDIUM' ? 0.3 : size === 'SMALL' ? 0.05 : 0.3) : size === 'LARGE' ? 3 : size === 'MEDIUM' ? 1 : size === 'SMALL' ? 0.3 : 2;
  return m / 1000;
}

// ---------------- covariance floor ----------------
/**
 * Minimum 1-sigma position error per object in radial / in-track / cross-track, km: 1 km in-track (the quoted epoch accuracy of
 * public sets), 0.3 km radial and cross-track. Applied after the model.
 */
export const SIGMA_FLOOR: Vec3 = [0.3, 1.0, 0.3];
export const floorSigma = (s: Vec3, floor: Vec3 = SIGMA_FLOOR): Vec3 => [Math.max(s[0], floor[0]), Math.max(s[1], floor[1]), Math.max(s[2], floor[2])];

// ---------------- manoeuvrable ----------------
/** Constellations whose satellites fly continuous low-thrust or frequent station-keeping burns. Active payloads only. */
export const MANOEUVRING_FAMILIES = ['STARLINK', 'ONEWEB', 'KUIPER', 'QIANFAN', 'HULIANWANG', 'GUOWANG', 'IRIDIUM', 'GLOBALSTAR', 'ORBCOMM'];
export const familyName = (name: string): string => (name.trim().split(/[\s\-]/)[0] ?? '').toUpperCase();
export function isManoeuvrable(o: { name: string; objectType?: string }): boolean {
  if (o.objectType === 'debris' || o.objectType === 'rocket_body') return false;
  return MANOEUVRING_FAMILIES.includes(familyName(o.name));
}

// ---------------- evaluation ----------------
export interface EvalObj { cat: SsaObject; prop: Prop }

/** SGP4 calls made by evaluateEncounter in this thread. */
export const evalCalls = { n: 0 };
const pv = (p: Prop, tMs: number): { r: Vec3; v: Vec3 } | null => {
  evalCalls.n++;
  const o = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = o ? o.position : null, v = o ? o.velocity : null;
  if (!r || !v || typeof r === 'boolean' || typeof v === 'boolean' || !Number.isFinite(r.x) || !Number.isFinite(v.x)) return null;
  return { r: [r.x, r.y, r.z], v: [v.x, v.y, v.z] };
};

const objLike = (c: SsaObject) => ({ noradId: c.noradId, regime: c.regime, objectType: c.objectType, perigee: c.perigee, bstar: Number(c.omm.BSTAR) });

/** Pc (balanced covariance with floor) and the worst case for one encounter at `tMs`. Null if either object fails SGP4 there. */
export function evaluateEncounter(A: EvalObj, B: EvalObj, tMs: number, volume: string, label: string, model: UncertaintyModel = defaultModel()): Encounter | null {
  const sa = pv(A.prop, tMs), sb = pv(B.prop, tMs);
  if (!sa || !sb) return null;
  const ba = ricBasis(sa.r, sa.v), bb = ricBasis(sb.r, sb.v);
  if (!ba || !bb) return null;
  const rel: Vec3 = [sb.r[0] - sa.r[0], sb.r[1] - sa.r[1], sb.r[2] - sa.r[2]];
  const vel: Vec3 = [sb.v[0] - sa.v[0], sb.v[1] - sa.v[1], sb.v[2] - sa.v[2]];
  const epA = epochMsOf(A.cat.omm), epB = epochMsOf(B.cat.omm);
  const ageA = (tMs - epA) / DAY_MS, ageB = (tMs - epB) / DAY_MS;
  const hbr = hardBodyRadiusKm(A.cat) + hardBodyRadiusKm(B.cat);
  const sA = floorSigma(sigmaRic(objLike(A.cat), ageA, model, false)), sB = floorSigma(sigmaRic(objLike(B.cat), ageB, model, false));
  const g = encounterGeometry(rel, vel, addSym3(covFromRic(ba, sA), covFromRic(bb, sB)));
  if (!g) return null;
  const ax = principalAxes(g.cov);
  return {
    noradA: A.cat.noradId, noradB: B.cat.noradId, nameA: A.cat.name, nameB: B.cat.name,
    tcaMs: tMs, missKm: g.miss, vrelKms: g.vrel, ricKm: toRic(rel, ba),
    volume,
    pc: pcFoster(g.mx, g.my, g.cov, hbr),
    pcMax: pcMax(g.mx, g.my, g.cov, hbr).pc,
    hbrKm: hbr,
    manoeuvrable: isManoeuvrable(A.cat) || isManoeuvrable(B.cat),
    label,
    epochA: epA, epochB: epB, ageDaysA: ageA, ageDaysB: ageB,
    sigmaMajKm: ax.s1, sigmaMinKm: ax.s2,
  };
}

// ---------------- matching between runs ----------------
export interface TcaKey { a: number; b: number; tca: number }
/**
 * One-to-one match of encounters of two runs: same pair (unordered), closest-approach times within `tolMs`, nearest first.
 * Returns for each index of `next` the index in `prev` (or -1).
 */
export function matchEncounters(prev: TcaKey[], next: TcaKey[], tolMs = 60_000): Int32Array {
  const pairKey = (e: TcaKey) => (e.a < e.b ? e.a * 4_294_967_296 + e.b : e.b * 4_294_967_296 + e.a);
  const byPair = new Map<number, number[]>();
  prev.forEach((e, i) => { const k = pairKey(e); const l = byPair.get(k); if (l) l.push(i); else byPair.set(k, [i]); });
  const out = new Int32Array(next.length).fill(-1);
  const taken = new Uint8Array(prev.length);
  // all candidate (next, prev) combinations within tolerance, best first, so two nearby encounters of one pair are not crossed over
  const cands: Array<[number, number, number]> = [];
  next.forEach((e, j) => { for (const i of byPair.get(pairKey(e)) ?? []) { const d = Math.abs(prev[i]!.tca - e.tca); if (d <= tolMs) cands.push([d, j, i]); } });
  cands.sort((x, y) => x[0] - y[0]);
  for (const [, j, i] of cands) if (out[j] === -1 && !taken[i]) { out[j] = i; taken[i] = 1; }
  return out;
}
