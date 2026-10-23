// ============================================================
// SPIKE — not production. Exact pass scan of one object over one time window (pure, no worker).
// Used by the refine step after the star-map summaries have narrowed the candidates, and unit-tested for
// grazes. Satellites are keyed in the star map only; this just evaluates a yes/no `inside` predicate.
// ============================================================
import type { Prop } from './runs.js';

export interface Flags { inside: boolean; near: boolean }

/**
 * Pass intervals of one object inside window [a,b]. Coarse step outside the near zone; fine step (1 s)
 * on every bracket that has a near end. Times: first and last in-sample of a pass (+-1 s).
 */
export function scanWindow(p: Prop, a: number, b: number, stepMs: number, nearStepMs: number, flags: (p: Prop, tm: number) => Flags, out: number[]): void {
  let open = -1, last = -1;
  const feed = (tm: number, f: Flags): void => {
    if (f.inside) { if (open < 0) open = tm; last = tm; }
    else if (open >= 0) { out.push(open, last); open = -1; }
  };
  let t0 = a, f0 = flags(p, t0);
  feed(t0, f0);
  while (t0 < b) {
    const t1 = Math.min(t0 + stepMs, b), f1 = flags(p, t1);
    if ((f0.near || f1.near) && t1 - t0 > nearStepMs) {
      for (let tt = t0 + nearStepMs; tt < t1; tt += nearStepMs) feed(tt, flags(p, tt));
    }
    feed(t1, f1);
    t0 = t1; f0 = f1;
  }
  if (open >= 0) out.push(open, last);
}

