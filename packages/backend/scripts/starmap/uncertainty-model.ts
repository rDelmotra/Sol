// ============================================================
// SPIKE — not production. U5: loader for data/uncertainty/model.json and the one function a screener calls.
//
//   sigmaRIC('LEO/unknown/p400-600', 2.0)            -> [sigR, sigI, sigC] in km (1 sigma, class level)
//   sigmaRIC({ noradId, regime, objectType, perigee, bstar }, 2.0)  -> same, with the object's own scale if it has one
//
// Fourth argument `true` gives the conservative variant (3-sigma share matched; wider core).
// `ageDays` = time from the element set's epoch to the moment of interest (always >= 0 here; the sign is dropped).
// The covariance is diagonal in the radial / in-track / cross-track frame of the object.
// Outside the fitted range 0.25..14 d: below 0.25 d the value at 0.25 d is used (nothing shorter was measured; the
// pair method cannot see the error at the epoch itself); beyond 14 d it continues along the
// tangent at 14 d (linear), which is an extrapolation and is only meant for small overshoots.
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classKey, fallbackKeys, normRegime, normType, MAX_GAP_D, MIN_GAP_D } from './uncertainty-lib.js';

export const MODEL_PATH = fileURLToPath(new URL('../../data/uncertainty/model.json', import.meta.url));

export interface Law { a: number; b: number; c: number; form?: string }
export interface ClassModel {
  n: number;
  /** growth law of the 1-sigma (km) per axis, class level, before the tail factor */
  growth: { R: Law; I: Law; C: Law };
}
export interface UncertaintyModel {
  version: number;
  classes: Record<string, ClassModel>;
  /** multiply sigma by this per regime (tail/calibration factor), default 1 */
  tail: Record<string, number | number[]>;
  /** same for objects without a per-object scale (class level only; wider) */
  tailCold?: Record<string, number | number[]>;
  /** gap-bin centres (days) the array form of `tail` is defined on; linear in log(age) between them, flat outside */
  tailCentresDays?: number[];
  /** extra multiplier per regime that makes the 3-sigma share match chi-square(3) (for tail-sensitive uses such as a worst-case Pc) */
  conservative?: Record<string, number>;
  /** per-object scale (shrunk), by NORAD id */
  objectScale: Record<string, number | [number, number, number]>;
  [k: string]: unknown;
}

let cached: UncertaintyModel | null = null;
export function loadModel(path: string = MODEL_PATH): UncertaintyModel {
  if (path === MODEL_PATH && cached) return cached;
  const m = JSON.parse(readFileSync(path, 'utf8')) as UncertaintyModel;
  if (path === MODEL_PATH) cached = m;
  return m;
}

export function evalLaw(l: Law, t0: number): number {
  const t = Math.max(t0, MIN_GAP_D); // below the shortest measured gap the curve stays at its value there (no zero error)
  if (t <= MAX_GAP_D) return Math.max(0, l.a + l.b * t + l.c * t * t);
  const v = l.a + l.b * MAX_GAP_D + l.c * MAX_GAP_D * MAX_GAP_D;
  const slope = l.b + 2 * l.c * MAX_GAP_D;
  return Math.max(0, v + slope * (t - MAX_GAP_D));
}

/** Piecewise-linear in log(x) through (xs, ys), flat outside. */
export function interpLog(xs: number[], ys: number[], x: number): number {
  if (!xs.length) return 1;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[xs.length - 1]!) return ys[ys.length - 1]!;
  let i = 0;
  while (xs[i + 1]! < x) i++;
  const f = (Math.log(x) - Math.log(xs[i]!)) / (Math.log(xs[i + 1]!) - Math.log(xs[i]!));
  return ys[i]! * (1 - f) + ys[i + 1]! * f;
}

export interface ObjectLike { noradId?: number; regime?: string; objectType?: string; perigee?: number; bstar?: number }

/** Class key of an object (same rule the fit used). */
export function classOf(o: ObjectLike): string {
  return classKey(o.regime ?? 'OTHER', normType(o.objectType), Number(o.perigee ?? 500), o.bstar);
}

/** Resolve a class key to the most specific one the model has. */
export function resolveClass(model: UncertaintyModel, key: string): string {
  if (model.classes[key]) return key;
  for (const k of fallbackKeys(key)) if (model.classes[k]) return k;
  return 'ALL';
}

/** 1-sigma position error [radial, in-track, cross-track] in km, `ageDays` after the element set's epoch. */
export function sigmaRIC(classOrObject: string | ObjectLike, ageDays: number, model: UncertaintyModel = loadModel(), conservative = false): [number, number, number] {
  const key = typeof classOrObject === 'string' ? classOrObject : classOf(classOrObject);
  const cls = model.classes[resolveClass(model, key)]!;
  const t = Math.abs(ageDays);
  const regime = normRegime(key.split('/')[0]);
  const raw = typeof classOrObject === 'string' || classOrObject.noradId === undefined ? undefined : model.objectScale[String(classOrObject.noradId)];
  const kt = raw === undefined ? model.tailCold : model.tail;
  const kv = kt?.[regime] ?? kt?.ALL ?? 1;
  const cf = conservative ? model.conservative?.[regime] ?? model.conservative?.ALL ?? 1 : 1;
  const k = cf * (typeof kv === 'number' ? kv : interpLog(model.tailCentresDays ?? [], kv, Math.max(t, 1e-6)));
  const s: [number, number, number] = raw === undefined ? [1, 1, 1] : typeof raw === 'number' ? [raw, raw, raw] : raw;
  return [evalLaw(cls.growth.R, t) * k * s[0], evalLaw(cls.growth.I, t) * k * s[1], evalLaw(cls.growth.C, t) * k * s[2]];
}
