// ============================================================
// "The catalog as of day D" from per-day element-set files (elset-files.ts): per object the latest set with epoch before D + 1 day 00:00
// UTC and not older than the staleness window, objects whose decay date is before D left out. The same rule as events/catalog.ts
// (loadDayCatalog) and coverage/catalog.ts (loadOmmCatalog) apply to omm_updates, so the same sets give the same catalog.
//
//   catalogAsOfDay()   one day, stream the files backwards from D (newest day first, the first set seen per object is its latest)
//   FileCatalog        a rolling map for many days: asOf(D) for a later D only reads the days after the previous one, adds their sets,
//                      drops the stale ones. A jump back in time, a gap longer than the window or a changed window re-reads from scratch.
// Joins of the DB loader (object_dim name / launch date, omm_daily regime) become the objects file + the elements: name = object name,
// else OBJECT_NAME of the set; regime from period and eccentricity of the set (as of the day, never from the future); perigee / apogee from
// the set.
// ============================================================
import { summarizeOrbit } from '../../utils/orbit-summary.js';
import { DAY_MS, type ChangeObject } from '../events/types.js';
import type { OmmObject } from '../coverage/catalog.js';
import { readElsetDay, type ObjectMeta } from './elset-files.js';

export const dayMs = (day: string): number => Date.parse(day + 'T00:00:00Z');
export const isoDayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Regime from period (min) and eccentricity: the thresholds of services/classifier.ts classifyRegime (ssa/ may not import services/). */
export function regimeOf(periodMin: number, ecc: number): string {
  if (ecc >= 0.25) return 'HEO';
  if (periodMin < 128) return 'LEO';
  if (periodMin >= 1380 && periodMin <= 1500 && ecc < 0.1) return 'GEO';
  if (periodMin >= 128 && periodMin < 1380) return 'MEO';
  return 'OTHER';
}

interface Entry { ep: number; omm: Record<string, unknown> }

/** Catalog entries (per object, ascending NORAD id) with the object file's fields joined. */
export function toChangeObjects(map: ReadonlyMap<number, Entry>, objects: ReadonlyMap<number, ObjectMeta>, day: string): ChangeObject[] {
  const out: ChangeObject[] = [];
  for (const id of [...map.keys()].sort((a, b) => a - b)) {
    const e = map.get(id)!;
    const meta = objects.get(id);
    if (meta?.decayDate && meta.decayDate < day) continue;
    const mm = Number(e.omm.MEAN_MOTION), ecc = Number(e.omm.ECCENTRICITY);
    const s = summarizeOrbit(mm, ecc);
    const o: ChangeObject = { noradId: id, name: meta?.name || String(e.omm.OBJECT_NAME ?? ''), regime: s ? regimeOf(s.period, ecc) : 'OTHER', omm: e.omm };
    if (s) { o.perigee = s.perigee; o.apogee = s.apogee; }
    if (meta?.launchDate) o.launchDate = meta.launchDate;
    out.push(o);
  }
  return out;
}

export const toOmmObjects = (objs: readonly ChangeObject[]): OmmObject[] => objs.map((o) => (o.propagator ? { noradId: o.noradId, omm: o.omm, propagator: o.propagator } : { noradId: o.noradId, omm: o.omm }));

/** First UTC day an object was in any catalog, from the objects file (the `returned` class of object.appeared). */
export const firstSeenOf = (objects: ReadonlyMap<number, ObjectMeta>, id: number): string | undefined => objects.get(id)?.firstEpoch?.slice(0, 10) || undefined;

/** Files that make the catalog of `day` with `windowDays`: the days [day + 1 - windowDays, day] (a set is kept while epoch >= D+1d - window, a day boundary). */
export function windowDayList(day: string, windowDays: number): string[] {
  const d0 = dayMs(day);
  const out: string[] = [];
  for (let k = 0; k < windowDays; k++) out.push(isoDayOf(d0 - k * DAY_MS)); // newest first
  return out;
}

function scanBackwards(dir: string, day: string, windowDays: number): Map<number, Entry> {
  const m = new Map<number, Entry>();
  for (const d of windowDayList(day, windowDays)) {
    for (const s of readElsetDay(dir, d)) {
      const cur = m.get(s.noradId);
      if (!cur || s.epochMs > cur.ep) m.set(s.noradId, { ep: s.epochMs, omm: s.omm });
    }
  }
  return m;
}

/** The catalog of one day by reading its window of files backwards. */
export function catalogAsOfDay(dir: string, objects: ReadonlyMap<number, ObjectMeta>, day: string, windowDays: number): ChangeObject[] {
  return toChangeObjects(scanBackwards(dir, day, windowDays), objects, day);
}

/** Rolling catalog for increasing days (any spacing). Not thread safe; one instance per process. */
export class FileCatalog {
  private map = new Map<number, Entry>();
  private lastDay: string | null = null;
  private lastWindow = 0;
  /** file reads performed (days), for tests and logs */
  filesRead = 0;
  rebuilds = 0;
  constructor(private readonly dir: string, private readonly objects: ReadonlyMap<number, ObjectMeta>) {}

  /** Advance (or rebuild) so the map is the catalog of `day`. */
  private advance(day: string, windowDays: number): void {
    const t = dayMs(day);
    const last = this.lastDay === null ? null : dayMs(this.lastDay);
    if (last === null || t < last || windowDays !== this.lastWindow || (t - last) / DAY_MS >= windowDays) {
      this.map = scanBackwards(this.dir, day, windowDays);
      this.filesRead += windowDays;
      this.rebuilds++;
    } else if (t > last) {
      for (let d = last + DAY_MS; d <= t; d += DAY_MS) {
        this.filesRead++;
        for (const s of readElsetDay(this.dir, isoDayOf(d))) {
          const cur = this.map.get(s.noradId);
          if (!cur || s.epochMs > cur.ep) this.map.set(s.noradId, { ep: s.epochMs, omm: s.omm });
        }
      }
      const minEp = t + DAY_MS - windowDays * DAY_MS;
      for (const [id, e] of this.map) if (e.ep < minEp) this.map.delete(id);
    }
    this.lastDay = day;
    this.lastWindow = windowDays;
  }

  /** The catalog (ChangeObject, ascending NORAD id) of `day`. */
  asOf(day: string, windowDays: number): ChangeObject[] {
    this.advance(day, windowDays);
    return toChangeObjects(this.map, this.objects, day);
  }
}
