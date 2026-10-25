// ============================================================
// SPIKE — not production. S5 (36 h forward conjunction screener): the pure pieces.
//   - causal catalog as of a batch time (latest element set per object that existed at that moment)
//   - hard-body radii by object type, covariance floor, the "manoeuvrable" label
//   - collision probability of one event under the balanced model, the conservative model, the worst case, and no floor
//   - event matching between batches (same pair, closest-approach time within a tolerance)
// Unit-tested in forward-lib.test.ts. The 2D Foster maths itself is in packages/orbital-core/src/collision.ts.
// ============================================================
import * as satellite from 'satellite.js';
import { ricBasis, toRic, covFromRic, addSym3, encounterGeometry, pcFoster, pcMax, principalAxes, type V3 } from '@orbitwatch/orbital-core';
import type { Prop } from './runs.js';
import { loadModel, sigmaRIC, type UncertaintyModel } from './uncertainty-model.js';
import { DAY_MS, dayStartMs, epochMsOf, loadDayCatalog, prevDay, type CatFull } from './events.js';

export const BATCH_HOUR = 12;
export const batchTimeMs = (day: string): number => dayStartMs(day) + BATCH_HOUR * 3_600_000;

// ---------------- causal catalog ----------------
export interface CausalCatalog { objs: CatFull[]; fallback: number; droppedNoEarlier: number; sameDayLater: number }

/**
 * The element sets a service would hold at `day` 12:00 UTC. The history file of day D keeps each object's latest set up to the
 * end of D, so about 5% of its sets have an epoch after 12:00 (in the batch's future). For those the object's set from the file
 * of D-1 (epochs up to D 00:00) is used instead; an object with no earlier set is left out. A set published between D 00:00 and
 * D 12:00 that was later replaced the same day is not in the files, so those objects are screened with an older set than a live
 * service would have (counted as `fallback`).
 */
export function causalCatalog(day: string): CausalCatalog {
  const t0 = batchTimeMs(day);
  const cur = loadDayCatalog(day), prev = loadDayCatalog(prevDay(day));
  const pm = new Map(prev.map((o) => [o.noradId, o]));
  const objs: CatFull[] = [];
  let fallback = 0, dropped = 0;
  for (const o of cur) {
    if (epochMsOf(o.omm) <= t0) { objs.push(o); continue; }
    const p = pm.get(o.noradId);
    if (p && epochMsOf(p.omm) <= t0) { objs.push(p); fallback++; } else dropped++;
  }
  return { objs, fallback, droppedNoEarlier: dropped, sameDayLater: fallback + dropped };
}

// ---------------- hard-body radius ----------------
/**
 * Hard-body radius of ONE object in km (the combined radius of a pair is the sum). A sphere that encloses the whole body
 * including panels. The catalog gives the object type and the radar size class (SMALL < 0.1 m^2, MEDIUM 0.1-1 m^2, LARGE > 1 m^2);
 * real satellites are larger than a sphere of equal radar area (panels, antennas), so the radii are set above that equivalent.
 *   payload / unknown : LARGE 3 m, MEDIUM 1 m, SMALL 0.3 m, no size 2 m
 *   rocket body       : LARGE 5 m, MEDIUM 2 m, no size 3 m   (a Falcon 9 stage is 3.7 m x 14 m, so the enclosing sphere is 7 m)
 *   debris            : LARGE 1 m, MEDIUM 0.3 m, SMALL 0.05 m, no size 0.3 m
 *   space stations    : ISS (and its docked stack) 55 m, Tiangong (CSS) stack 25 m, from the overall span of the structures
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
 * Minimum 1-sigma position error per object in radial / in-track / cross-track, km. Applied after the model (and after the
 * conservative multiplier). U5 measures how consistent successive public sets are (0.04 / 0.28 / 0.04 km for LEO at 6 h) and says the true error against
 * an independent orbit is larger, in particular at short ages; public sets are quoted as good to about 1 km at epoch. So the floor is
 * 1 km in-track (the quoted epoch accuracy; in-track is where the error lives) and 0.3 km radial and cross-track (U5's R and C are
 * 5 to 10 times smaller than I at all ages; 0.3 km is the smallest value that keeps the floor from dominating long-age predictions).
 */
export const SIGMA_FLOOR: V3 = [0.3, 1.0, 0.3];
export const floorSigma = (s: V3, floor: V3 = SIGMA_FLOOR): V3 => [Math.max(s[0], floor[0]), Math.max(s[1], floor[1]), Math.max(s[2], floor[2])];

// ---------------- manoeuvrable ----------------
/**
 * Constellations whose satellites fly continuous low-thrust or frequent station-keeping burns, so a prediction from a few-day-old
 * element set is least reliable (U5: the Starlink-like drag/thrust class has 1-sigma in-track 36 km at 1 day). Active payloads only.
 */
export const MANOEUVRING_FAMILIES = ['STARLINK', 'ONEWEB', 'KUIPER', 'QIANFAN', 'HULIANWANG', 'GUOWANG', 'IRIDIUM', 'GLOBALSTAR', 'ORBCOMM'];
export const familyName = (name: string): string => (name.trim().split(/[\s\-]/)[0] ?? '').toUpperCase();
export function isManoeuvrable(o: { name: string; objectType?: string }): boolean {
  if (o.objectType === 'debris' || o.objectType === 'rocket_body') return false;
  return MANOEUVRING_FAMILIES.includes(familyName(o.name));
}

// ---------------- event evaluation ----------------
/** S6: which screening volume the event lies in (see s6-lib.ts). Absent on S5 events. */
export interface VolInfo {
  /** volume id (1-8) of a and of b, by their own regime */
  va: number; vb: number;
  /** b is inside a's volume / a is inside b's volume (box test) */
  inA: boolean; inB: boolean;
  /** same with the ellipsoid inscribed in the box */
  ellA: boolean; ellB: boolean;
  /** within the 5 km sphere of S5 */
  in5: boolean;
  /** position of a relative to b in b's radial / in-track / cross-track frame, km */
  ricB: V3;
}

export interface FwdEvent {
  a: number; b: number; nameA: string; nameB: string;
  tca: number; miss: number; vrel: number;
  /** position of b relative to a in a's radial / in-track / cross-track frame at TCA, km */
  ric: V3;
  epA: number; epB: number; ageA: number; ageB: number;
  cat: string;
  manA: boolean; manB: boolean; jumpA: boolean; jumpB: boolean;
  slow: boolean; old: boolean;
  hbr: number;
  /** combined balanced error ellipse in the encounter plane: 1-sigma major / minor, km (with floor) */
  sMaj: number; sMin: number;
  pcBal: number; pcCons: number; pcMax: number; pcBalNoFloor: number;
  vol?: VolInfo;
}

export interface EvalObj { cat: CatFull; prop: Prop }

/** SGP4 calls made by evaluateEvent in this thread (real counter). */
export const evalCalls = { n: 0 };
const pv = (p: Prop, tMs: number): { r: V3; v: V3 } | null => {
  evalCalls.n++;
  const o = satellite.sgp4(p.satrec, (tMs - p.epochMs) / 60_000);
  const r = o ? o.position : null, v = o ? o.velocity : null;
  if (!r || !v || typeof r === 'boolean' || typeof v === 'boolean' || !Number.isFinite(r.x) || !Number.isFinite(v.x)) return null;
  return { r: [r.x, r.y, r.z], v: [v.x, v.y, v.z] };
};

const objLike = (c: CatFull) => ({ noradId: c.noradId, regime: c.regime, objectType: (c as unknown as { objectType?: string }).objectType, perigee: c.perigee, bstar: Number(c.omm.BSTAR) });

/** Pc for the four variants (balanced, conservative, worst-case scaling, balanced without floor). Null if either object fails SGP4 at `tMs`. */
export function evaluateEvent(A: EvalObj, B: EvalObj, tMs: number, catLabel: string, flags: { jumpA: boolean; jumpB: boolean }, model: UncertaintyModel = loadModel()): FwdEvent | null {
  const sa = pv(A.prop, tMs), sb = pv(B.prop, tMs);
  if (!sa || !sb) return null;
  const ba = ricBasis(sa.r, sa.v), bb = ricBasis(sb.r, sb.v);
  if (!ba || !bb) return null;
  const rel: V3 = [sb.r[0] - sa.r[0], sb.r[1] - sa.r[1], sb.r[2] - sa.r[2]];
  const vel: V3 = [sb.v[0] - sa.v[0], sb.v[1] - sa.v[1], sb.v[2] - sa.v[2]];
  const ageA = (tMs - epochMsOf(A.cat.omm)) / DAY_MS, ageB = (tMs - epochMsOf(B.cat.omm)) / DAY_MS;
  const la = objLike(A.cat), lb = objLike(B.cat);
  const hbr = hardBodyRadiusKm(A.cat as never) + hardBodyRadiusKm(B.cat as never);
  const cov = (conservative: boolean, floor: boolean) => {
    let sA = sigmaRIC(la, ageA, model, conservative), sB = sigmaRIC(lb, ageB, model, conservative);
    if (floor) { sA = floorSigma(sA); sB = floorSigma(sB); }
    return addSym3(covFromRic(ba, sA), covFromRic(bb, sB));
  };
  const cBal = cov(false, true);
  const g = encounterGeometry(rel, vel, cBal);
  if (!g) return null;
  const gCons = encounterGeometry(rel, vel, cov(true, true))!;
  const gNoFloor = encounterGeometry(rel, vel, cov(false, false))!;
  const ax = principalAxes(g.cov);
  const manA = isManoeuvrable(A.cat), manB = isManoeuvrable(B.cat);
  return {
    a: A.cat.noradId, b: B.cat.noradId, nameA: A.cat.name, nameB: B.cat.name,
    tca: tMs, miss: g.miss, vrel: g.vrel, ric: toRic(rel, ba),
    epA: epochMsOf(A.cat.omm), epB: epochMsOf(B.cat.omm), ageA, ageB, cat: catLabel,
    manA, manB, jumpA: flags.jumpA, jumpB: flags.jumpB,
    slow: g.vrel < 0.5, old: Math.max(ageA, ageB) > 14,
    hbr, sMaj: ax.s1, sMin: ax.s2,
    pcBal: pcFoster(g.mx, g.my, g.cov, hbr),
    pcCons: pcFoster(gCons.mx, gCons.my, gCons.cov, hbr),
    pcMax: pcMax(g.mx, g.my, g.cov, hbr).pc,
    pcBalNoFloor: pcFoster(gNoFloor.mx, gNoFloor.my, gNoFloor.cov, hbr),
  };
}

// ---------------- matching between batches ----------------
export interface TcaKey { a: number; b: number; tca: number }
/**
 * One-to-one match of events of two batches: same pair (unordered), closest-approach times within `tolMs`, nearest first.
 * Returns for each index of `next` the index in `prev` (or -1).
 */
export function matchEvents(prev: TcaKey[], next: TcaKey[], tolMs = 60_000): Int32Array {
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

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const x = (sorted.length - 1) * q, lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (x - lo);
}
