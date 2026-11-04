// ============================================================
// Era settings of the history backfill: ONE table, by calendar year, for the two things that depend on how densely an era was tracked.
//
//   windowDays   staleness window of the catalog: the catalog of day D holds, per object, the latest element set with epoch inside
//                [D + 1 d - windowDays, D + 1 d). Production uses 30 (CATALOG_WINDOW_DAYS). In the early decades objects were
//                updated every few days to weeks; a 30-day window makes them flicker in and out of the catalog (object.disappeared /
//                object.appeared noise), so those years need a longer window.
//                Note: the coverage build refuses element sets more than 60 days from the day ("outside-60d-epoch-cap"), so a window
//                above 60 gives catalog entries that coverage skips (counted in the manifest's `skipped`), not wrong answers.
//   jumpDposKm   elements.jump thresholds (events/types.ts: 16.3 km position step, 1 km semi-major-axis step). Older sets are
//   jumpDaKm     noisier; raise them if era-stats / the chain check show a large fitting noise floor.
//
// HOW TO FILL IT: run scripts/history/era-stats.py on the converted element sets; it prints per year the median and p90 gap between
// consecutive element sets of an object and a suggested window = max(30 d, 1.5 x p90). Put the suggested numbers here (or in a JSON
// file passed to build-range.ts --era-file, same shape as ERA_TABLE).
//
// THE VALUES BELOW ARE PLACEHOLDERS, NOT MEASUREMENTS: the lab data was not available when this was written. Only `fromYear: 2010`
// (the modern 30-day window and the production thresholds) is the production setting.
// ============================================================
import { CATALOG_WINDOW_DAYS, JUMP_DA_KM, JUMP_DPOS_KM } from '../events/types.js';

export interface EraSettings {
  /** first calendar year (UTC) of the era; the era runs until the next row's fromYear */
  fromYear: number;
  windowDays: number;
  jumpDposKm: number;
  jumpDaKm: number;
  note?: string;
}

/** Ascending by fromYear. PLACEHOLDERS except the last row - fill from era-stats.py. */
export const ERA_TABLE: readonly EraSettings[] = [
  { fromYear: 1959, windowDays: 60, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: JUMP_DA_KM, note: 'PLACEHOLDER: first decade, sparse tracking' },
  { fromYear: 1970, windowDays: 45, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: JUMP_DA_KM, note: 'PLACEHOLDER' },
  { fromYear: 1990, windowDays: 35, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: JUMP_DA_KM, note: 'PLACEHOLDER' },
  { fromYear: 2010, windowDays: CATALOG_WINDOW_DAYS, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: JUMP_DA_KM, note: 'modern = production values' },
];

export function validateEraTable(t: readonly EraSettings[]): readonly EraSettings[] {
  if (!t.length) throw new Error('era table is empty');
  for (let i = 0; i < t.length; i++) {
    const r = t[i]!;
    if (![r.fromYear, r.windowDays, r.jumpDposKm, r.jumpDaKm].every(Number.isFinite) || r.windowDays < 1) throw new Error(`era table row ${i}: bad numbers`);
    if (i > 0 && r.fromYear <= t[i - 1]!.fromYear) throw new Error('era table must ascend by fromYear');
  }
  return t;
}

/** Settings in force on `day` ('YYYY-MM-DD'). Days before the first row use the first row. */
export function eraFor(day: string, table: readonly EraSettings[] = ERA_TABLE): EraSettings {
  const y = Number(day.slice(0, 4));
  let cur = table[0]!;
  for (const r of table) if (r.fromYear <= y) cur = r;
  return cur;
}
