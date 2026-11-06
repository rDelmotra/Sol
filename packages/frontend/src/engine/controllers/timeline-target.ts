import { MS_PER_DAY } from '@orbitwatch/orbital-core';
import { utcDay, type HistoryCoverage } from '../../data/history-client';
import type { HistoryRange } from '../../data/replay-types';

/**
 * How far back the LIVE element sets are trusted, in days before today (UTC).
 * Older view-times switch to the history REPLAY catalog of that day when the
 * archive covers it. Today's sets propagated a month back are already tens of km
 * off in LEO (and the archive's last day is months behind now), so 30 d is the
 * line: "a date more than 30 days before now replays the archive".
 */
export const LIVE_REACH_DAYS = 30;

/** What the satellite render plane currently shows for the view-time. */
export type CatalogTarget =
  | { kind: 'live' }
  | { kind: 'day'; day: string }
  /** History REPLAY: the archive catalog as of the end of `day` (/api/history/catalog). */
  | { kind: 'replay'; day: string }
  | { kind: 'hidden' };

export interface CatalogTargetInput {
  /** The simulation (view) time, epoch ms. */
  simMs: number;
  /** Wall-clock now, epoch ms. */
  wallMs: number;
  coverage: HistoryCoverage | null;
  /** Forward horizon in days (FUTURE_HORIZON_DAYS from @orbitwatch/orbital-core). */
  futureHorizonDays: number;
  /** Replay archive span (/api/history/range); null/absent = no archive (503). */
  replayRange?: HistoryRange | null;
}

/** What the catalog SHOULD show for the given view-time. */
export function computeCatalogTarget({
  simMs,
  wallMs,
  coverage: cov,
  futureHorizonDays,
  replayRange,
}: CatalogTargetInput): CatalogTarget {
  const today = utcDay(wallMs);
  // Live TLEs are only meaningful (and cheap to propagate) near their epoch. Beyond a
  // forward horizon, satellites go planetarium (sky only) — symmetric with the past,
  // and keeps far-future times out of the SGP4 worker. See @orbitwatch/orbital-core propagation-window.ts.
  const horizon = utcDay(wallMs + futureHorizonDays * MS_PER_DAY);
  const t = utcDay(simMs);
  if (t > horizon) return { kind: 'hidden' };                   // beyond forward horizon → planetarium
  if (t >= today) return { kind: 'live' };                      // today .. +horizon → current elements
  // REPLAY rule: older than the live reach AND inside the archive → that day's archive catalog.
  // Everything else falls through to the unchanged rules (so with no archive nothing changes).
  const reach = utcDay(wallMs - LIVE_REACH_DAYS * MS_PER_DAY);
  if (replayRange && t < reach && t >= replayRange.firstDay && t <= replayRange.lastDay) {
    return { kind: 'replay', day: t };
  }
  if (!cov || !cov.from || !cov.to) return { kind: 'hidden' };  // no history → planetarium
  if (t < cov.from) return { kind: 'hidden' };                  // before coverage → planetarium
  if (t > cov.to) return { kind: 'live' };                      // recent gap not yet ingested → current
  return { kind: 'day', day: t };                               // covered past day
}

/** Stable comparison key for a target (so scrubbing across uncovered days never churns). */
export function targetKey(t: CatalogTarget): string {
  return t.kind === 'day' ? t.day : t.kind === 'replay' ? `replay:${t.day}` : t.kind;
}

/**
 * The neighbouring day to warm while a replay day is loaded: the next day when
 * the clock runs forward (or is paused), the previous one when it runs backward.
 * Null when that neighbour is outside the archive.
 */
export function prefetchNeighbour(day: string, simRate: number, range: HistoryRange | null): string | null {
  if (!range) return null;
  const step = simRate < 0 ? -1 : 1;
  const d = new Date(Date.parse(`${day}T00:00:00Z`) + step * MS_PER_DAY).toISOString().slice(0, 10);
  return d < range.firstDay || d > range.lastDay ? null : d;
}
