// ============================================================
// object.breakup: a cluster of newly catalogued debris pieces that share one launch (international designator YYYY-NNN) and appear
// close together in time. A pure function of the `object.appeared` events (who entered the catalog on which day) and the objects
// metadata (type, designator, name); it needs no element sets and no database.
//
//   pieces     objects of type 'debris' whose designator starts with the launch YYYY-NNN and whose FIRST appearance is a new object
//              (appeared class `new_launch` or `newly_cataloged`; `returned` = an old object coming back into the catalog is not a piece)
//   cluster    the pieces of one launch ordered by first-appearance day; a new cluster starts when the gap to the previous piece is
//              longer than `windowDays` (default 60), so one fragmentation whose pieces are catalogued over months stays one cluster
//              and a later, unrelated one of the same launch is a second cluster
//   emitted    clusters with at least `minPieces` pieces (default 10)
//   parent     the non-debris object of the launch: if several (a launch with many payloads) the one whose tracking ended nearest
//              (within 14 days) to the cluster's first day, else the lowest NORAD id; with no such object the earliest piece
//
// Event row (ssa_event shape): day = first day of the cluster, t_start / t_end = first / last day (00:00 UTC) of the pieces,
// subjects = [parent?, ...pieces ascending], payload { launch, parentNorad, parentName, pieces, firstDay, lastDay, names }.
// Known limits (HISTORY_BACKFILL.md, "Breakups"): launch-time debris of a busy launch can pass for a breakup (false positive); a
// breakup of an object whose pieces carry another launch's designator, or one that is catalogued as pieces without a debris type, is
// missed; and the piece count is the count in the data range, not the final count.
// ============================================================
import type { ObjectMeta } from './elset-files.js';
import { BREAKUP_KIND } from '../events/types.js';

export const BREAKUP_MIN_PIECES = 10;
export const BREAKUP_WINDOW_DAYS = 60;
const NAMES_SAMPLE = 5;
const PARENT_NEAR_DAYS = 14;
const DAY_MS = 86_400_000;

export interface BreakupOpts { minPieces?: number; windowDays?: number }
/** One object.appeared event, reduced to what the deriver needs. */
export interface AppearedRef { noradId: number; /** 'YYYY-MM-DD' */ day: string; /** appeared class (payload.cls) when known */ cls?: string | null }

export interface BreakupEvent {
  kind: typeof BREAKUP_KIND;
  /** first day of the cluster */
  day: string;
  subjects: number[];
  tStart: number;
  tEnd: number;
  payload: { launch: string; parentNorad: number | null; parentName: string | null; pieces: number; firstDay: string; lastDay: string; names: string[] };
}

const LAUNCH_RE = /^(\d{4}-\d{3})/;
export const launchOf = (designator: string | null | undefined): string | null => LAUNCH_RE.exec(designator ?? '')?.[1] ?? null;
const dayMs = (d: string): number => Date.parse(d + 'T00:00:00Z');

export function deriveBreakups(appeared: Iterable<AppearedRef>, objects: ReadonlyMap<number, ObjectMeta>, opts: BreakupOpts = {}): BreakupEvent[] {
  const minPieces = opts.minPieces ?? BREAKUP_MIN_PIECES, windowMs = (opts.windowDays ?? BREAKUP_WINDOW_DAYS) * DAY_MS;
  // first appearance of each candidate piece: the earliest event; an object whose earliest event is 'returned' is not new
  const first = new Map<number, AppearedRef>();
  for (const a of appeared) {
    const cur = first.get(a.noradId);
    if (!cur || a.day < cur.day) first.set(a.noradId, a);
  }
  const byLaunch = new Map<string, Array<{ id: number; day: string }>>();
  for (const [id, a] of first) {
    if (a.cls === 'returned') continue;
    const m = objects.get(id);
    if (!m || m.objectType !== 'debris') continue;
    const launch = launchOf(m.intlDesignator);
    if (!launch) continue;
    (byLaunch.get(launch) ?? byLaunch.set(launch, []).get(launch)!).push({ id, day: a.day });
  }
  // non-debris objects of each launch (the parent candidates)
  const bodies = new Map<string, ObjectMeta[]>();
  for (const m of objects.values()) {
    if (m.objectType === 'debris') continue;
    const l = launchOf(m.intlDesignator);
    if (l && byLaunch.has(l)) (bodies.get(l) ?? bodies.set(l, []).get(l)!).push(m);
  }

  const out: BreakupEvent[] = [];
  for (const [launch, pieces] of byLaunch) {
    if (pieces.length < minPieces) continue;
    pieces.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id - b.id));
    let start = 0;
    for (let i = 1; i <= pieces.length; i++) {
      if (i < pieces.length && dayMs(pieces[i]!.day) - dayMs(pieces[i - 1]!.day) <= windowMs) continue;
      const cl = pieces.slice(start, i);
      start = i;
      if (cl.length < minPieces) continue;
      const firstDay = cl[0]!.day, lastDay = cl[cl.length - 1]!.day;
      const ids = cl.map((p) => p.id).sort((a, b) => a - b);
      const parent = pickParent(bodies.get(launch) ?? [], firstDay) ?? objects.get(cl[0]!.id)!;
      const parentNorad = parent.noradId;
      const seenNames = new Set<string>();
      const names: string[] = [];
      for (const id of ids) {
        const n = objects.get(id)?.name;
        if (n && !seenNames.has(n)) { seenNames.add(n); names.push(n); if (names.length >= NAMES_SAMPLE) break; }
      }
      out.push({
        kind: BREAKUP_KIND, day: firstDay,
        subjects: [parentNorad, ...ids.filter((id) => id !== parentNorad)],
        tStart: dayMs(firstDay), tEnd: dayMs(lastDay),
        payload: { launch, parentNorad, parentName: parent.name || null, pieces: ids.length, firstDay, lastDay, names },
      });
    }
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.payload.launch < b.payload.launch ? -1 : a.payload.launch > b.payload.launch ? 1 : a.payload.firstDay < b.payload.firstDay ? -1 : 1));
}

function pickParent(cands: readonly ObjectMeta[], firstDay: string): ObjectMeta | null {
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0]!;
  const t0 = dayMs(firstDay);
  let best: ObjectMeta | null = null, bestD = Infinity;
  for (const m of cands) {
    const end = m.decayDate ? Date.parse(m.decayDate) : m.lastEpoch ? Date.parse(m.lastEpoch) : NaN;
    const d = Number.isFinite(end) ? Math.abs(end - t0) : Infinity;
    if (d <= PARENT_NEAR_DAYS * DAY_MS && d < bestD) { best = m; bestD = d; }
  }
  return best ?? [...cands].sort((a, b) => a.noradId - b.noradId)[0]!;
}
