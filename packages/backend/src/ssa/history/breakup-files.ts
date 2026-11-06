// ============================================================
// object.breakup on files: the appeared events of a history build (<root>/events/YYYY/<day>.jsonl.gz, written by build-range.ts) in,
// <root>/events/breakups.jsonl.gz out (one ssa_event row per line, the same shape as the day files: { day, kind, subjects, t_start,
// t_end, payload }). A breakup is derived from many days, so it lives in one file of its own and not in a day file (the importer
// replaces it as a whole: import-events.ts).
// ============================================================
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BREAKUP_KIND } from '../events/types.js';
import { deriveBreakups, type AppearedRef, type BreakupEvent, type BreakupOpts } from './breakup.js';
import type { ObjectMeta } from './elset-files.js';

export interface BreakupLine { day: string; kind: typeof BREAKUP_KIND; subjects: number[]; t_start: string; t_end: string; payload: BreakupEvent['payload'] }

export const breakupsPath = (root: string): string => join(root, 'events', 'breakups.jsonl.gz');

export const breakupLine = (e: BreakupEvent): BreakupLine => ({ day: e.day, kind: e.kind, subjects: e.subjects, t_start: new Date(e.tStart).toISOString(), t_end: new Date(e.tEnd).toISOString(), payload: e.payload });

/** The newly-appeared objects of the day files under `root`/events, optionally only days in [from, to]. */
export function readAppeared(root: string, from?: string, to?: string): AppearedRef[] {
  const ev = join(root, 'events');
  const out: AppearedRef[] = [];
  if (!existsSync(ev)) return out;
  for (const y of readdirSync(ev).sort()) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const f of readdirSync(join(ev, y)).sort()) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(f);
      if (!m || (from && m[1]! < from) || (to && m[1]! > to)) continue;
      for (const l of gunzipSync(readFileSync(join(ev, y, f))).toString('utf8').split('\n')) {
        if (!l.includes('"object.appeared"')) continue;
        const r = JSON.parse(l) as { day: string; kind: string; subjects: number[]; payload?: { cls?: string } };
        if (r.kind === 'object.appeared' && r.subjects[0] !== undefined) out.push({ noradId: r.subjects[0], day: r.day, cls: r.payload?.cls ?? null });
      }
    }
  }
  return out;
}

/** Derive the breakups of the appeared events under `root` and write events/breakups.jsonl.gz (atomically). Returns the events. */
export function writeBreakups(root: string, objects: ReadonlyMap<number, ObjectMeta>, opts: BreakupOpts = {}, range?: { from?: string; to?: string }): BreakupEvent[] {
  const evs = deriveBreakups(readAppeared(root, range?.from, range?.to), objects, opts);
  const p = breakupsPath(root);
  mkdirSync(join(root, 'events'), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, gzipSync(evs.map((e) => JSON.stringify(breakupLine(e))).join('\n') + (evs.length ? '\n' : '')));
  renameSync(tmp, p);
  return evs;
}

export function readBreakupLines(root: string): BreakupLine[] {
  const p = breakupsPath(root);
  if (!existsSync(p)) return [];
  return gunzipSync(readFileSync(p)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as BreakupLine);
}
