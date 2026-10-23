// ============================================================
// SPIKE — not production. Pure region-pass scanner used by events-worker.ts (and unit-tested).
//
// Input is a function `sample(tMs)` that returns a bit mask of the regions the object is inside (low 8 bits)
// plus, in bits 8..15, a "near" mask (the object is within a safety margin of that region's edge).
// Method: coarse step; wherever either end of a coarse bracket is near some region, walk the bracket at
// `fineMs` (1 s) so a graze shorter than the coarse step is not missed; otherwise bisect a mask change down
// to 1 s. Output records [objIndex, region, tIn, tOut, flags] (flags bit0 = already inside at the window
// start, bit1 = still inside at the window end).
// ============================================================
export const REGION_BITS = 8;
/** Optional exact geometry: the sub-satellite lat/lon of the latest sample, and whether the straight chord between two samples
 *  can touch an edge of any region (so a graze between samples is possible). With it the near bits are not needed. */
export interface ChordGeo {
  ll: (out: Float64Array) => void;
  chord: (a: Float64Array, b: Float64Array) => boolean;
}
export const NEAR_SHIFT = 8;
const MASK = (1 << REGION_BITS) - 1;

export function scanRegions(
  obj: number, sample: (tMs: number) => number, t0Ms: number, t1Ms: number, stepMs: number, fineMs: number, out: number[],
  nRegions = REGION_BITS,
  geo?: ChordGeo,
): { samples: number; fineBrackets: number } {
  let fineBrackets = 0;
  const llPrev = new Float64Array(2), llNow = new Float64Array(2);
  let samples = 0;
  const S = (tm: number): number => { samples++; return sample(tm); };
  const open = new Float64Array(nRegions), openFlag = new Int8Array(nRegions);
  const first = S(t0Ms);
  geo?.ll(llPrev);
  let state = first & MASK, nearPrev = first >> NEAR_SHIFT;
  for (let r = 0; r < nRegions; r++) { open[r] = state & (1 << r) ? t0Ms : -1; openFlag[r] = 1; }
  const apply = (tm: number, m: number): void => {
    const ch = m ^ state;
    for (let r = 0; r < nRegions; r++) {
      if (!(ch & (1 << r))) continue;
      if (m & (1 << r)) { open[r] = tm; openFlag[r] = 0; }
      else { out.push(obj, r, open[r]!, tm, openFlag[r]!); open[r] = -1; }
    }
    state = m;
  };
  const resolve = (tLo: number, mLo: number, tHi: number, mHi: number, ev: Array<[number, number]>): void => {
    if (mLo === mHi) return;
    if (tHi - tLo <= 1000) { ev.push([Math.round((tLo + tHi) / 2), mHi]); return; }
    const tMid = Math.floor((tLo + tHi) / 2), mMid = S(tMid) & MASK;
    if (mMid !== mLo) resolve(tLo, mLo, tMid, mMid, ev);
    if (mMid !== mHi) resolve(tMid, mMid, tHi, mHi, ev);
  };
  let tPrev = t0Ms;
  for (let tm = t0Ms + stepMs; tm <= t1Ms + 1e-6; tm += stepMs) {
    const s = S(tm), m = s & MASK, nearNow = s >> NEAR_SHIFT;
    if (geo) geo.ll(llNow);
    // fine walk only if the straight chord between the two samples can touch a nearby region edge (or, without geometry, whenever near)
    const walk = tm - tPrev > fineMs && (geo ? geo.chord(llPrev, llNow) : (nearPrev | nearNow) !== 0);
    if (walk) {
      fineBrackets++;
      // fine walk: every fineMs inside the bracket, each fine bracket resolved by its midpoint
      let tl = tPrev;
      for (let tt = tPrev + fineMs; tt < tm; tt += fineMs) {
        const mm = S(tt) & MASK;
        if (mm !== state) apply(Math.round((tl + tt) / 2), mm);
        tl = tt;
      }
      if (m !== state) apply(Math.round((tl + tm) / 2), m);
    } else if (m !== state) {
      const ev: Array<[number, number]> = [];
      resolve(tPrev, state, tm, m, ev);
      for (const [te, me] of ev) apply(te, me);
      if (state !== m) apply(tm, m); // bisection collapsed (flicker): force to the sample state
    }
    tPrev = tm; nearPrev = nearNow;
    if (geo) { llPrev[0] = llNow[0]!; llPrev[1] = llNow[1]!; }
  }
  for (let r = 0; r < nRegions; r++) if (open[r]! >= 0) out.push(obj, r, open[r]!, t1Ms, openFlag[r]! | 2);
  return { samples, fineBrackets };
}
