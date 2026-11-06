/**
 * Replay events pane model: one SsaEvent → a neutral, plain-language row. Pure
 * (no React, no store), tested in replay-events.test.ts.
 */
import type { SsaEvent } from '@orbitwatch/contracts';
import type { BreakupPayload } from '../../../data/replay-types';

/** What the pane needs to know about an object of the loaded day's catalog. */
export interface CatalogEntry {
  index: number;
  name: string;
  designator: string | null;
  launchDate: string | null;
}

export interface EventRowModel {
  id: number;
  kind: string;
  tag: string;
  title: string;
  detail: string;
  /** The object a click selects and centres; null when none. */
  noradId: number | null;
  /** Index of `noradId` in the loaded catalog; null = not in this day's catalog (not selectable). */
  index: number | null;
  breakup: BreakupPayload | null;
}

const KIND_ORDER: Record<string, number> = {
  'object.breakup': 0,
  'object.appeared': 1,
  'elements.jump': 2,
  'object.disappeared': 3,
  'close.formation': 4,
};

const TAG: Record<string, string> = {
  'object.breakup': 'BREAKUP',
  'object.appeared': 'NEW OBJECT',
  'elements.jump': 'ORBIT CHANGE',
  'object.disappeared': 'NO LONGER TRACKED',
  'close.formation': 'FORMATION',
};

const DISAPPEARED_CLASS: Record<string, string> = {
  decay_likely: 'low last orbit · decay likely',
  ambiguous_low: 'low orbit · elements aged out',
  stale_window: 'elements aged out of the window',
  unexplained: 'no further element sets',
};

type Payload = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const signed = (v: number, digits: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

/** Parse an object.breakup payload; null when malformed. */
export function breakupPayload(p: unknown): BreakupPayload | null {
  const o = (p ?? {}) as Payload;
  const launch = str(o.launch);
  if (!launch) return null;
  return {
    launch,
    parentNorad: num(o.parentNorad),
    pieces: num(o.pieces) ?? 0,
    firstDay: str(o.firstDay) ?? '',
    lastDay: str(o.lastDay) ?? '',
  };
}

function label(norad: number, lookup: (n: number) => CatalogEntry | undefined, payloadName: string | null): string {
  const name = lookup(norad)?.name ?? payloadName;
  return name ? `${name} (${norad})` : `NORAD ${norad}`;
}

export function describeEvent(ev: SsaEvent, lookup: (norad: number) => CatalogEntry | undefined): EventRowModel {
  const p = (ev.payload ?? {}) as Payload;
  const first = ev.subjects[0] ?? null;
  const entry = first !== null ? lookup(first) : undefined;
  const base: EventRowModel = {
    id: ev.id,
    kind: ev.kind,
    tag: TAG[ev.kind] ?? ev.kind.toUpperCase(),
    title: first !== null ? label(first, lookup, str(p.name)) : ev.kind,
    detail: '',
    noradId: first,
    index: entry ? entry.index : null,
    breakup: null,
  };

  switch (ev.kind) {
    case 'object.appeared': {
      const launch = str(p.launch) ?? entry?.launchDate ?? null;
      const parts = [launch ? `launch ${launch}` : 'launch date not listed'];
      if (entry?.designator) parts.push(entry.designator);
      const perigee = num(p.perigee), apogee = num(p.apogee);
      if (perigee !== null && apogee !== null) parts.push(`${Math.round(perigee)} × ${Math.round(apogee)} km`);
      return { ...base, detail: parts.join(' · ') };
    }
    case 'object.breakup': {
      const b = breakupPayload(p);
      if (!b) return { ...base, detail: 'breakup (details not listed)' };
      const parent = b.parentNorad !== null ? lookup(b.parentNorad) : undefined;
      const parentLabel = b.parentNorad !== null ? label(b.parentNorad, lookup, str(p.parentName)) : 'parent not identified';
      const span = b.firstDay && b.lastDay && b.firstDay !== b.lastDay ? ` · catalogued ${b.firstDay} – ${b.lastDay}` : b.firstDay ? ` · first catalogued ${b.firstDay}` : '';
      return {
        ...base,
        title: `LAUNCH ${b.launch} · ${b.pieces} PIECES`,
        detail: `parent ${parentLabel}${span}`,
        noradId: b.parentNorad,
        index: parent ? parent.index : null,
        breakup: b,
      };
    }
    case 'elements.jump': {
      const da = num(p.da), dpos = num(p.dpos);
      const parts: string[] = [];
      if (da !== null) parts.push(`Δa ${signed(da, 1)} km`);
      if (dpos !== null) parts.push(`Δpos ${dpos.toFixed(0)} km`);
      const acc = Array.isArray(p.acc) ? num(p.acc[0]) : null;
      if (acc !== null) parts.push(`era noise ~${Math.round(acc)} km`);
      return { ...base, detail: parts.join(' · ') || 'element set differs from the previous one' };
    }
    case 'object.disappeared': {
      const cls = str(p.cls);
      const lastEpoch = str(p.lastEpoch);
      const parts = [DISAPPEARED_CLASS[cls ?? ''] ?? 'no further element sets'];
      if (lastEpoch) parts.push(`last set ${lastEpoch.slice(0, 10)}`);
      return { ...base, detail: parts.join(' · ') };
    }
    case 'close.formation': {
      const second = ev.subjects[1];
      const minKm = num(p.minKm);
      return {
        ...base,
        title: second !== undefined ? `${base.title} / ${label(second, lookup, null)}` : base.title,
        detail: minKm !== null ? `within 50 km most of the day · closest ${minKm.toFixed(1)} km` : 'within 50 km most of the day',
      };
    }
    default:
      return base;
  }
}

/** Rows for a day: breakups first, then new objects, orbit changes, objects no longer tracked; by title within a kind. */
export function eventRows(events: readonly SsaEvent[], lookup: (norad: number) => CatalogEntry | undefined): EventRowModel[] {
  return events
    .map((e) => describeEvent(e, lookup))
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.title.localeCompare(b.title));
}

/** Per-tag counts for the pane header ("3 NEW · 1 BREAKUP ..."). */
export function countByKind(rows: readonly EventRowModel[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

/** Fragment selection: launch designators + parent ids (store/types ReplayFragments). */
export interface FragmentSelection {
  launches: string[];
  parentNorads: number[];
}

/** Toggle one breakup in the fragments selection; null when nothing is left. */
export function toggleFragments(current: FragmentSelection | null, b: BreakupPayload): FragmentSelection | null {
  const launches = current ? [...current.launches] : [];
  const parents = current ? [...current.parentNorads] : [];
  const at = launches.indexOf(b.launch);
  if (at >= 0) {
    launches.splice(at, 1);
    if (b.parentNorad !== null) {
      const pi = parents.indexOf(b.parentNorad);
      if (pi >= 0) parents.splice(pi, 1);
    }
  } else {
    launches.push(b.launch);
    if (b.parentNorad !== null && !parents.includes(b.parentNorad)) parents.push(b.parentNorad);
  }
  return launches.length > 0 ? { launches, parentNorads: parents } : null;
}
