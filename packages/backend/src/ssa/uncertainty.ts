// ============================================================
// Position-uncertainty model (U5): class-level growth laws of the 1-sigma error in the radial / in-track / cross-track frame.
// Ported unchanged from scripts/starmap/uncertainty-lib.ts + uncertainty-model.ts (class keys, growth laws, tail factors).
//
//   sigmaRic(object, ageDays, model) -> [sigR, sigI, sigC] km, 1 sigma, diagonal covariance in the object's own RIC frame.
//
// Where the coefficients come from: the class-level table is embedded (uncertainty-defaults.ts). The per-object scale table is
// large (~2 MB) and optional: set SSA_UNCERTAINTY_MODEL to a model.json file (the full U5 output) to load it; without it objects
// take the class-level 'cold' tail factor (wider, never narrower than the per-object scaled value).
// Outside the fitted range 0.25..14 d: below 0.25 d the value at 0.25 d is used, beyond 14 d it continues along the tangent at 14 d.
// ============================================================
import { readFileSync } from 'node:fs';
import { DEFAULT_MODEL_DATA } from './uncertainty-defaults.js';

export const MIN_GAP_D = 0.25;
export const MAX_GAP_D = 14;

export type ObjType = 'unknown' | 'rocket_body' | 'debris';
export const normType = (t: unknown): ObjType => (t === 'rocket_body' || t === 'debris' ? t : 'unknown');
export const normRegime = (r: unknown): string => (r === 'LEO' || r === 'MEO' || r === 'GEO' || r === 'HEO' ? (r as string) : 'OTHER');

/** LEO perigee bands (km above surface). */
const LEO_BANDS: Array<[number, number, string]> = [[-1e9, 400, 'p<400'], [400, 600, 'p400-600'], [600, 800, 'p600-800'], [800, 1e9, 'p>=800']];
export const leoBand = (perigeeKm: number): string => LEO_BANDS.find(([lo, hi]) => perigeeKm >= lo && perigeeKm < hi)![2];

/** LEO drag bands by |BSTAR| (1 / earth radii): the strongest single predictor of along-track error. */
const BSTAR_EDGES = [1e-4, 5e-4, 1.5e-3];
export const bstarBand = (bstar: number): string => `b${BSTAR_EDGES.filter((e) => Math.abs(bstar) >= e).length}`;

/** Class key: regime/type, and for LEO also the perigee band and the drag band (when bstar is known). */
export function classKey(regime: string, type: string, perigeeKm: number, bstar?: number): string {
  const r = normRegime(regime);
  if (r !== 'LEO') return `${r}/${type}`;
  const base = `LEO/${type}/${leoBand(perigeeKm)}`;
  return bstar === undefined || !Number.isFinite(bstar) ? base : `${base}/${bstarBand(bstar)}`;
}
/** Coarser fallbacks, most specific first (excluding the key itself). */
export function fallbackKeys(key: string): string[] {
  const p = key.split('/');
  const out: string[] = [];
  if (p.length === 4) out.push(`${p[0]}/${p[1]}/${p[2]}`);
  if (p.length >= 3) out.push(`${p[0]}/${p[1]}`, `${p[0]}/${p[2]}`);
  out.push(p[0]!, 'ALL');
  return out;
}

export interface Law { a: number; b: number; c: number }
export interface ClassModel { growth: { R: Law; I: Law; C: Law } }
export interface UncertaintyModel {
  version: number;
  classes: Record<string, ClassModel>;
  /** multiply sigma by this per regime (tail/calibration factor), default 1 */
  tail: Record<string, number | number[]>;
  /** same for objects without a per-object scale (class level only; wider) */
  tailCold?: Record<string, number | number[]>;
  /** gap-bin centres (days) the array form of tail is defined on; linear in log(age) between them, flat outside */
  tailCentresDays?: number[];
  /** extra multiplier per regime for tail-sensitive uses (not used by the screener's Pc) */
  conservative?: Record<string, number>;
  /** per-object scale (shrunk), by NORAD id */
  objectScale: Record<string, number | [number, number, number]>;
}

let defaults: UncertaintyModel | null = null;
/** The embedded class-level model (no per-object scales). */
export function defaultModel(): UncertaintyModel {
  if (defaults) return defaults;
  const d = DEFAULT_MODEL_DATA as unknown as { version: number; classes: Record<string, { R: number[]; I: number[]; C: number[] }>; tail: UncertaintyModel['tail']; tailCold: UncertaintyModel['tailCold']; tailCentresDays: number[] };
  const law = (x: number[]): Law => ({ a: x[0]!, b: x[1]!, c: x[2]! });
  const classes: UncertaintyModel['classes'] = {};
  for (const [k, c] of Object.entries(d.classes)) classes[k] = { growth: { R: law(c.R), I: law(c.I), C: law(c.C) } };
  defaults = { version: d.version, classes, tail: d.tail, tailCold: d.tailCold, tailCentresDays: d.tailCentresDays, objectScale: {} };
  return defaults;
}

const fileCache = new Map<string, UncertaintyModel>();
/** Model from `path`, else SSA_UNCERTAINTY_MODEL, else the embedded defaults. */
export function loadUncertaintyModel(path: string | undefined = process.env.SSA_UNCERTAINTY_MODEL): UncertaintyModel {
  if (!path) return defaultModel();
  const hit = fileCache.get(path);
  if (hit) return hit;
  const m = JSON.parse(readFileSync(path, 'utf8')) as UncertaintyModel;
  if (!m.classes || !m.tail) throw new Error(`uncertainty model ${path}: missing classes/tail`);
  m.objectScale ??= {};
  fileCache.set(path, m);
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
export function sigmaRic(classOrObject: string | ObjectLike, ageDays: number, model: UncertaintyModel = defaultModel(), conservative = false): [number, number, number] {
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
