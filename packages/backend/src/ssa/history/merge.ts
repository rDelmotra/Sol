// ============================================================
// Merging two sources of historical element sets (history backfill, pre-1980) and a robust outlier filter that works on either.
//
// Sources:  'mirror'  the Space-Track GP-history mirror (convert.py), every era;
//           'jcm'     Jonathan McDowell's archive (convert-mcdowell.py: cross-tag corrected, Brouwer mean motions converted, NDOT2 kept,
//                     PROBLEM sets dropped). Its sets carry HIST_SRC = 'jcm'.
//
// Merge rule (chosen by the chain check on the downloaded sample, design/marvin/HISTORY_BACKFILL.md section 9): per object and calendar
//   year before `cutYear` (default 1980), where McDowell has sets: McDowell's version of the sets the mirror also has ('matched', see
//   mergeSources); elsewhere the mirror's sets. From cutYear on: the mirror only (1980+ outputs byte-identical). Measured alternatives
//   ('available': all McDowell sets; 'union': plus the mirror's extra epochs; per object-year 'better' chain median) were worse in
//   1959-1961 and/or 1962-1971.
//
// Outlier filter: a set is dropped when BOTH neighbours (previous and next set of the same object, each no further than maxGapDays)
//   disagree with it by more than thresholdKm(epoch) at its epoch (the neighbour propagated to the set's epoch with its own model)
//   AND the two neighbours agree with each other (previous propagated to the next epoch) within that limit.
//   One pass over the original neighbours, so two consecutive bad sets cannot shield each other only if both neighbours are good; a set
//   with a single neighbour in range is never dropped. Threshold = k x the era's chain p95 (k from the data, see the runbook).
// ============================================================
import { makeProp, posAt, type PropagatorKind } from '../events/orbit.js';
import type { Elset } from './elset-files.js';

export type KindOf = (s: Elset) => PropagatorKind | undefined;
export type MergeRule = 'matched' | 'available' | 'union';

const DAY = 86_400_000;
const yearOf = (ms: number): number => new Date(ms).getUTCFullYear();

/** Map noradId -> its sets ascending by epoch (the input is not modified). */
export function byObject(sets: readonly Elset[]): Map<number, Elset[]> {
  const m = new Map<number, Elset[]>();
  for (const s of sets) (m.get(s.noradId) ?? m.set(s.noradId, []).get(s.noradId)!).push(s);
  for (const l of m.values()) l.sort((a, b) => a.epochMs - b.epochMs);
  return m;
}

/** Position difference (km) between set `from` propagated to `to`'s epoch and `to` at its epoch; NaN when either fails. */
export function disagreementKm(from: Elset, to: Elset, kindOf?: KindOf): number {
  const pa = makeProp(from.omm, kindOf?.(from)), pb = makeProp(to.omm, kindOf?.(to));
  const ra = pa ? posAt(pa, to.epochMs) : null, rb = pb ? posAt(pb, to.epochMs) : null;
  if (!ra || !rb) return NaN;
  return Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]);
}

export interface OutlierResult { kept: Elset[]; dropped: Elset[] }

/**
 * Drop sets inconsistent with BOTH neighbours (see the header). `sets` = one object's sets ascending by epoch (byObject), or any mix
 * (grouped here). thresholdKm(epochMs) gives the limit for a set at that epoch; non-finite = never drop.
 */
export function filterOutliers(sets: readonly Elset[], thresholdKm: (epochMs: number) => number, maxGapDays: number, kindOf?: KindOf): OutlierResult {
  const kept: Elset[] = [], dropped: Elset[] = [];
  for (const list of byObject(sets).values()) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!, p = list[i - 1], n = list[i + 1];
      const thr = thresholdKm(s.epochMs);
      const near = (o: Elset | undefined): o is Elset => !!o && Math.abs(o.epochMs - s.epochMs) <= maxGapDays * DAY && o.epochMs !== s.epochMs;
      if (!Number.isFinite(thr) || !near(p) || !near(n)) { kept.push(s); continue; }
      const dp = disagreementKm(p, s, kindOf), dn = disagreementKm(n, s, kindOf);
      // a neighbour that cannot be propagated gives no evidence against the set (NaN > thr is false); the neighbours must agree with
      // each other (previous propagated to the next epoch) within the same limit, so a manoeuvre or two inconsistent neighbours never
      // condemn the set in the middle
      if (dp > thr && dn > thr && disagreementKm(p, n, kindOf) <= thr) dropped.push(s); else kept.push(s);
    }
  }
  return { kept, dropped };
}

export interface MergeStats { objectYears: number; fromJcm: number; fromMirror: number; jcmSets: number; mirrorSets: number; jcmUnmatched: number }

/** Epochs (ms) per object. */
function epochsByObject(sets: readonly Elset[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const s of sets) (m.get(s.noradId) ?? m.set(s.noradId, []).get(s.noradId)!).push(s.epochMs);
  return m;
}
const near = (list: readonly number[] | undefined, t: number): boolean => !!list && list.some((x) => Math.abs(x - t) <= 1000);

/**
 * Merge per object and calendar year (see the header). Sets of years >= cutYear always come from the mirror. Returns the chosen sets
 * (unsorted) and counts. Rules, for an object-year McDowell has sets for (otherwise the mirror's sets):
 *   'matched'   (default) McDowell's version of every set the mirror also has: same object, or - for a set McDowell moved here from
 *               another object (cross-tag correction) - that object (XTLE_TLE_NUMBER), epoch within 1 s. McDowell-only sets are kept
 *               only when the mirror has no set of that object-year at all.
 *   'available' all of McDowell's sets.
 *   'union'     McDowell's sets plus the mirror's at epochs McDowell does not have, except the sets McDowell moved to another object.
 * Expects the sets of one or more whole calendar years (the merge runs per year).
 */
export function mergeSources(mirror: readonly Elset[], jcm: readonly Elset[], opts: { cutYear?: number; rule?: MergeRule } = {}): { sets: Elset[]; stats: MergeStats } {
  const cutYear = opts.cutYear ?? 1980, rule = opts.rule ?? 'matched';
  const key = (s: Elset): string => `${s.noradId}:${yearOf(s.epochMs)}`;
  const group = (xs: readonly Elset[]): Map<string, Elset[]> => {
    const m = new Map<string, Elset[]>();
    for (const s of xs) (m.get(key(s)) ?? m.set(key(s), []).get(key(s))!).push(s);
    for (const l of m.values()) l.sort((a, b) => a.epochMs - b.epochMs);
    return m;
  };
  const gm = group(mirror), gj = group(jcm.filter((s) => yearOf(s.epochMs) < cutYear));
  const mirrorEpochs = epochsByObject(mirror);
  // sets McDowell moved away from an object (the old number stays inside the TLE): never taken back from the mirror under that number
  const moved = epochsByObject(jcm.filter((s) => Number.isInteger(Number(s.omm.XTLE_TLE_NUMBER)) && Number(s.omm.XTLE_TLE_NUMBER) !== s.noradId)
    .map((s) => ({ ...s, noradId: Number(s.omm.XTLE_TLE_NUMBER) })));
  const out: Elset[] = [];
  const st: MergeStats = { objectYears: 0, fromJcm: 0, fromMirror: 0, jcmSets: 0, mirrorSets: 0, jcmUnmatched: 0 };
  for (const k of new Set([...gm.keys(), ...gj.keys()])) {
    const m = gm.get(k) ?? [], j = gj.get(k) ?? [];
    st.objectYears++;
    if (!j.length) { out.push(...m); st.fromMirror++; st.mirrorSets += m.length; continue; }
    st.fromJcm++;
    if (rule === 'matched' && m.length) {
      const keep = j.filter((s) => near(mirrorEpochs.get(s.noradId), s.epochMs) || near(mirrorEpochs.get(Number(s.omm.XTLE_TLE_NUMBER)), s.epochMs));
      out.push(...keep); st.jcmSets += keep.length; st.jcmUnmatched += j.length - keep.length;
    } else if (rule === 'union' && m.length) {
      const je = j.map((s) => s.epochMs), mv = moved.get(m[0]!.noradId);
      const extra = m.filter((s) => !near(je, s.epochMs) && !near(mv, s.epochMs));
      out.push(...j, ...extra); st.jcmSets += j.length; st.mirrorSets += extra.length;
    } else {
      out.push(...j); st.jcmSets += j.length;
    }
  }
  return { sets: out, stats: st };
}
