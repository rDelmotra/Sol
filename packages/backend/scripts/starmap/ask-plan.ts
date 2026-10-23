// ============================================================
// SPIKE — not production. The planner's decision table (pure; unit-tested in ask.test.ts).
// A question is classified by its time window (instant / hours / days / months) and its kind, and sent to the
// cheapest layer that can answer it with 100% recall, given what has been built:
//   L4 live window   SGP4 on demand, nothing stored
//   L3 derived events  lookups in starmap.event (derived once per day)
//   L2 star-map coverage summaries (hourly where present, else daily) + exact refine on the candidates
// ============================================================
export type WindowKind = 'instant' | 'hours' | 'days' | 'months';
export type QuestionKind = 'region-in-time' | 'one-vs-all' | 'all-vs-all' | 'box-in-time' | 'repeated-fact';

export interface Question {
  id: number;
  text: string;
  window: WindowKind;
  kind: QuestionKind;
  /** UTC days (YYYY-MM-DD) the window covers, for windows of a day or more. */
  days?: string[];
  /** repeated-fact only: the fact kind that Layer 3 derives (e.g. 'region.pass'), and the region code in its payload. */
  fact?: { kind: string; region?: string };
  /** all-vs-all only: the threshold asked for (km), against the one Layer 3 stores. */
  thresholdKm?: number;
}

export interface Avail {
  /** days whose events are in starmap.event, by kind */
  derived: Record<string, Set<string>>;
  hourly: Set<string>;
  daily: Set<string>;
  /** miss distance (km) up to which close.approach rows are stored */
  storedApproachKm: number;
}

export interface Plan {
  layer: 'L4' | 'L3' | 'L2' | 'L3+L2';
  route: string;
  why: string;
  /** coverage granularity chosen for L2 */
  gran?: 'hour' | 'day';
}

const allIn = (days: string[] | undefined, s: Set<string> | undefined): boolean => !!days && days.length > 0 && !!s && days.every((d) => s.has(d));

export function plan(q: Question, av: Avail): Plan {
  if (q.window === 'instant') {
    return { layer: 'L4', route: 'SGP4 for every object at the one instant, then point-in-polygon',
      why: 'one instant: nothing stored can beat running SGP4 once for all 33k objects (tens of ms)' };
  }
  if (q.window === 'hours' && q.kind === 'one-vs-all') {
    return { layer: 'L4', route: 'coarse time filter (SGP4 every 30 s, 20 km/s pad), then 1 s refine only near hits',
      why: 'one object against all over hours: the live window is cheap, and nothing is derived for arbitrary objects' };
  }
  if ((q.window === 'hours' || q.window === 'days') && q.kind === 'all-vs-all') {
    if (allIn(q.days, av.derived['close.approach'])) {
      const partial = (q.thresholdKm ?? 0) > av.storedApproachKm;
      return { layer: 'L3', route: 'lookup in starmap.event (kind close.approach, by day)',
        why: `the day is derived, so it is a lookup${partial ? `; the store only keeps misses under ${av.storedApproachKm} km and relative speed >= 0.5 km/s, so the ${av.storedApproachKm}-${q.thresholdKm} km remainder is answered only by the L4 grid, on demand` : ''}` };
    }
    return { layer: 'L4', route: 'per-step spatial grid over all objects (5 s), refine candidate pairs',
      why: 'the day is not derived, so the live grid is the only path' };
  }
  if (q.window === 'days' && (q.kind === 'region-in-time' || q.kind === 'box-in-time')) {
    const hourly = allIn(q.days, av.hourly), daily = allIn(q.days, av.daily);
    if (!hourly && !daily) return { layer: 'L4', route: 'brute force SGP4 day by day', why: 'no coverage summaries for these days' };
    const gran = hourly ? 'hour' : 'day';
    const ground = q.kind === 'region-in-time';
    return { layer: 'L2', gran,
      route: `${ground ? 'rotate the region into the star map per period (order 4)' : 'the box itself (order 3)'}, merge the ${gran}ly lists, exact refine on candidate windows`,
      why: `${gran}ly summaries exist for every day; ${ground ? 'a ground region needs the finer periods because it sweeps the whole star-map ring in a day' : 'a box is a summary cell, so the lists give the candidates directly'}` };
  }
  if (q.kind === 'repeated-fact') {
    const f = q.fact!;
    if (allIn(q.days, av.derived[f.kind])) {
      return { layer: 'L3+L2', route: `lookup in starmap.event (kind ${f.kind}${f.region ? ', region ' + f.region : ''}); cross-check with L2 summaries + refine for that object`,
        why: 'a named fact over a long window is exactly what the daily job derives; the L2 path is the independent second opinion' };
    }
    return { layer: 'L2', route: 'coverage summaries + refine', why: 'the fact is not derived for all days' };
  }
  return { layer: 'L4', route: 'brute force', why: 'no cheaper path known' };
}
