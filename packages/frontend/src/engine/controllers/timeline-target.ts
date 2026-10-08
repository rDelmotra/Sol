import { MS_PER_DAY } from '@orbitwatch/orbital-core';
import { utcDay, type HistoryCoverage } from '../../data/history-client';

/** What the satellite render plane currently shows for the view-time. */
export type CatalogTarget =
  | { kind: 'live' }
  | { kind: 'day'; day: string }
  | { kind: 'hidden' };

export interface CatalogTargetInput {
  /** The simulation (view) time, epoch ms. */
  simMs: number;
  /** Wall-clock now, epoch ms. */
  wallMs: number;
  coverage: HistoryCoverage | null;
  /** Forward horizon in days (FUTURE_HORIZON_DAYS from @orbitwatch/orbital-core). */
  futureHorizonDays: number;
}

/** What the catalog SHOULD show for the given view-time. */
export function computeCatalogTarget({
  simMs,
  wallMs,
  coverage: cov,
  futureHorizonDays,
}: CatalogTargetInput): CatalogTarget {
  const today = utcDay(wallMs);
  // Live TLEs are only meaningful (and cheap to propagate) near their epoch. Beyond a
  // forward horizon, satellites go planetarium (sky only) — symmetric with the past,
  // and keeps far-future times out of the SGP4 worker. See @orbitwatch/orbital-core propagation-window.ts.
  const horizon = utcDay(wallMs + futureHorizonDays * MS_PER_DAY);
  const t = utcDay(simMs);
  if (t > horizon) return { kind: 'hidden' };                   // beyond forward horizon → planetarium
  if (t >= today) return { kind: 'live' };                      // today .. +horizon → current elements
  if (!cov || !cov.from || !cov.to) return { kind: 'hidden' };  // no history → planetarium
  if (t < cov.from) return { kind: 'hidden' };                  // before coverage → planetarium
  if (t > cov.to) return { kind: 'live' };                      // recent gap not yet ingested → current
  return { kind: 'day', day: t };                               // covered past day
}

/** Stable comparison key for a target (so scrubbing across uncovered days never churns). */
export function targetKey(t: CatalogTarget): string {
  return t.kind === 'day' ? t.day : t.kind;
}
