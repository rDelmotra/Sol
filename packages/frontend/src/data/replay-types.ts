// ============================================================
// Wire types of the history REPLAY API (/api/history/range, /catalog, /timeline)
// as the frontend reads them. The wire shapes live in @orbitwatch/contracts
// (history.ts); this file re-exports them under the names the replay code uses,
// narrows the range to the validated (non-empty) form, and adds the pieces the
// contract does not carry (the object.breakup payload, the bucket granularity).
// Every frontend reader imports from here.
// ============================================================

import type {
  HistoryCatalog,
  HistoryCatalogObject,
  HistoryOmm,
  HistoryRange as WireHistoryRange,
  HistoryTimelineBucket,
} from '@orbitwatch/contracts';

export type { HistoryCatalogObject, HistoryOmm };

/** GET /api/history/range, after validation (replay-client): an archive with a first and last day. */
export type HistoryRange = Omit<WireHistoryRange, 'firstDay' | 'lastDay'> & { firstDay: string; lastDay: string };

/** GET /api/history/catalog?day= — the catalog as of the END of that UTC day. */
export type HistoryCatalogResponse = HistoryCatalog;

/** Typical position error of the era's element sets with the era's model. */
export type HistoryAccuracy = NonNullable<HistoryCatalog['accuracy']>;

/** Propagation model an element set was generated for. 'sgp' = the original SGP (pre-1980 sets without B*). */
export type HistoryPropagator = HistoryCatalogObject['propagator'];

/** Bucket size of GET /api/history/timeline. */
export type TimelineGranularity = 'day' | 'month' | 'year';

/** One bucket of GET /api/history/timeline (`t` = ISO start of the bucket; empty buckets are left out). */
export type HistoryTimelinePoint = HistoryTimelineBucket;

/** Payload of an `object.breakup` SsaEvent (backend src/ssa/history/breakup.ts). */
export interface BreakupPayload {
  /** Launch designator of the pieces, e.g. '1993-036'. */
  launch: string;
  parentNorad: number | null;
  pieces: number;
  firstDay: string;
  lastDay: string;
}

/** The event kinds the replay UI shows, in display order. */
export const REPLAY_EVENT_KINDS = [
  'object.appeared',
  'object.breakup',
  'elements.jump',
  'object.disappeared',
] as const;
export type ReplayEventKind = (typeof REPLAY_EVENT_KINDS)[number];
