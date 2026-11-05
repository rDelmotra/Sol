// ============================================================
// Which propagation model a history element set gets (history backfill only; production is always SGP4).
//
// Element sets before the mid-1970s were generated for the original SGP model: no B* (BSTAR = 0 in 99 % of the 1959-1970 sets),
// drag carried by MEAN_MOTION_DOT (= ndot/2, rev/day^2, the same convention as today: the change of MEAN_MOTION between
// consecutive sets divided by the gap is 2.0-2.2 x the field in every era). SGP4 ignores MEAN_MOTION_DOT, so with B* = 0 it flies
// those objects drag-free and they fall behind along-track by ~ 2 pi (ndot/2) t^2 rev (measured: along-track error / that
// prediction has median 1.01-1.13 for low-perigee B* = 0 pairs, 1960-1979). SGP (orbital-core sgp.ts) puts the drag back.
//
// The rule, per era row (era.ts `sgp`), chosen by the chain check on 1959-1985 (design/marvin/HISTORY_BACKFILL.md):
//   BSTAR != 0                                  -> SGP4 (those sets were made for SGP4)
//   BSTAR == 0 and the era has no `sgp` policy  -> SGP4 (1980 on: SGP measurably does not help the B* = 0 sets there)
//   BSTAR == 0, deep space (period >= 225 min)  -> SGP only if the policy says deepSpace (1959-1972: SGP-era sets, SGP wins;
//                                                  later SGP4/SDP4 with its lunisolar terms wins)
//   BSTAR == 0, near Earth                      -> SGP if the predicted drag drift 2 pi a |ndot/2| (km/day^2) is at least
//                                                  minDriftKmD2 (0 = always; 1973-1979: 3 km/day^2, below that MEAN_MOTION_DOT is
//                                                  mostly noise and SGP4 is closer on the median)
//
// Source metadata first (McDowell's archive, convert-mcdowell.py: XTLE_ELTYPE from XTLE line 3): a set labelled 'SGP' is propagated with
// SGP in any era. The label 'SGP4' is the format's DEFAULT and is on every set of the archive (measured: 558,265 of 558,265 sets
// 1957-1985 in the 12 downloaded folders, including the 1958-1972 B* = 0 sets made for SGP: on them SGP4 gives e.g. 1965 median /
// p95 194 / 2367 km vs 69 / 455 km with the era rule, HISTORY_BACKFILL.md section 9), so 'SGP4' is NOT taken as a statement about
// the model: those sets, and sets without the field (the mirror), follow the era rule above. SGP uses MEAN_MOTION_DDOT when non-zero
// (convert-mcdowell.py writes 0 by default: McDowell's NDOT2 did not help).
// ============================================================
import type { ChangeObject } from '../events/types.js';
import type { PropagatorKind } from '../encounter.js';

export interface SgpPolicy {
  /** near-Earth B* = 0 sets use SGP when 2 pi a |MEAN_MOTION_DOT| >= this (km/day^2); 0 = always */
  minDriftKmD2: number;
  /** also deep-space (period >= 225 min) B* = 0 sets */
  deepSpace: boolean;
}

const MU = 398600.4418;

/** Predicted along-track drag drift of a set, km/day^2: 2 pi a |ndot/2| (a from the mean motion). NaN for unusable numbers. */
export function dragDriftKmD2(omm: Record<string, unknown>): number {
  const n = Number(omm.MEAN_MOTION), nd = Number(omm.MEAN_MOTION_DOT ?? 0);
  if (!(n > 0) || !Number.isFinite(nd)) return NaN;
  const a = Math.cbrt(MU / ((n * 2 * Math.PI) / 86400) ** 2);
  return 2 * Math.PI * a * Math.abs(nd);
}

/** The model for one set under an era's policy; undefined = SGP4 (the default, so SGP4 objects carry no field). */
export function propagatorFor(omm: Record<string, unknown>, policy: SgpPolicy | undefined): PropagatorKind | undefined {
  if (omm.XTLE_ELTYPE === 'SGP' && Number(omm.MEAN_MOTION) > 0) return 'sgp';
  if (!policy || Number(omm.BSTAR ?? 0) !== 0) return undefined;
  const n = Number(omm.MEAN_MOTION);
  if (!(n > 0)) return undefined;
  if (1440 / n >= 225) return policy.deepSpace ? 'sgp' : undefined;
  if (policy.minDriftKmD2 > 0 && !(dragDriftKmD2(omm) >= policy.minDriftKmD2)) return undefined;
  return 'sgp';
}

/** The catalog with `propagator: 'sgp'` set where the policy says so (other objects are returned unchanged, without the field). */
export function assignPropagators(objs: ChangeObject[], policy: SgpPolicy | undefined): ChangeObject[] {
  if (!policy) return objs;
  return objs.map((o) => {
    const k = propagatorFor(o.omm, policy);
    return k ? { ...o, propagator: k } : o;
  });
}
