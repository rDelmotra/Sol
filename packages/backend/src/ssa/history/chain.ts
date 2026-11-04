// ============================================================
// SGP4 self-consistency of a series of element sets of one object ("chain check"): propagate each set to the epoch of the next set
// and compare with the next set's own position at its epoch. For a healthy series (right numbers, right units) the difference is
// small and grows with the gap; wrong B*, wrong mean-motion rate or mixed-up angles show up as large differences at short gaps.
// A manoeuvre or a re-fit is a genuine outlier, so read the median and the p95, not the maximum.
// ============================================================
import { makeProp, posAt } from '../events/orbit.js';
import type { Elset } from './elset-files.js';

export interface ChainPair { noradId: number; gapDays: number; dposKm: number }

/** Pairs of consecutive sets (same object, ascending epoch) no further apart than maxGapDays. Returns the pairs and the number that failed to propagate. */
export function chainPairs(sets: readonly Elset[], maxGapDays: number): { pairs: ChainPair[]; failed: number } {
  const by = new Map<number, Elset[]>();
  for (const s of sets) (by.get(s.noradId) ?? by.set(s.noradId, []).get(s.noradId)!).push(s);
  const pairs: ChainPair[] = [];
  let failed = 0;
  for (const [noradId, list] of by) {
    list.sort((a, b) => a.epochMs - b.epochMs);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!, b = list[i]!;
      const gap = (b.epochMs - a.epochMs) / 86_400_000;
      if (gap <= 0 || gap > maxGapDays) continue;
      const pa = makeProp(a.omm), pb = makeProp(b.omm);
      const ra = pa ? posAt(pa, b.epochMs) : null, rb = pb ? posAt(pb, b.epochMs) : null;
      if (!ra || !rb) { failed++; continue; }
      pairs.push({ noradId, gapDays: gap, dposKm: Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]) });
    }
  }
  return { pairs, failed };
}

export const quantile = (sorted: readonly number[], q: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : NaN);

export interface ChainSummary { pairs: number; failed: number; medianKm: number; p95Km: number; p99Km: number; medianGapDays: number }
export function summarizeChain(pairs: readonly ChainPair[], failed: number): ChainSummary {
  const d = pairs.map((p) => p.dposKm).sort((a, b) => a - b);
  const g = pairs.map((p) => p.gapDays).sort((a, b) => a - b);
  return { pairs: pairs.length, failed, medianKm: quantile(d, 0.5), p95Km: quantile(d, 0.95), p99Km: quantile(d, 0.99), medianGapDays: quantile(g, 0.5) };
}
