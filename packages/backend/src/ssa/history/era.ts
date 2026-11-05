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
//   sgp          propagation of B* = 0 sets (propagator-policy.ts): SGP instead of SGP4 where the era's sets were made for SGP.
//   accuracy     typical position error with the era's model (chain check: a set propagated to the next set of the same object, next
//                set <= 5 d later, whole year): written to coverage manifests (`accuracy`) and elements.jump payloads (`acc`).
//
// WHERE THE NUMBERS COME FROM (design/marvin/HISTORY_BACKFILL.md, "Pre-1980 element sets"):
//   windowDays   era-stats.py on the lab's converted mirror (owner's run): 1959 34, 1960 30, 1961 30, 1962 61, 1963 93, 1964 87, 1965 49,
//                1966 88, 1967 41, 1968 58, 1969 47, 1970 31, 1971+ 30.
//   sgp          chain check 1959-1985 per model: SGP for every B* = 0 set wins in 1959-1972 (also deep space); in 1973-1979 only
//                near-Earth sets with a drag drift >= 3 km/day^2 gain; from 1980 SGP does not help (B* = 0 sets there are mostly deep
//                space, where SGP4/SDP4 is better) -> SGP4 only, so 1980+ needs no rebuild.
//   jump*        per year the smallest thresholds (cost log(da) + log(dpos / 16.3)) that bring the elements.jump rate of debris and
//                rocket bodies (which cannot manoeuvre: every flag is false) down to <= 1.2 % of their changed sets, the 1980-1985
//                level at the production thresholds. The binding test is |da| and |resid| (the semi-major-axis step), not dpos:
//                early mean motions carry gross errors (cross-tagged / bad sets), so before 1971 only large changes are detectable.
//   1959         too few objects to fit (8 changed debris sets): the 1960 thresholds.
// Rows from 1980 on are the production settings. A JSON file passed to build-range.ts --era-file replaces this table (same shape);
// `build-range.ts --print-era` writes this table as such a file.
// ============================================================
import { CATALOG_WINDOW_DAYS, JUMP_DA_KM, JUMP_DPOS_KM } from '../events/types.js';
import type { SgpPolicy } from './propagator-policy.js';
import type { PositionAccuracy } from '../coverage/store.js';

export interface EraSettings {
  /** first calendar year (UTC) of the era; the era runs until the next row's fromYear */
  fromYear: number;
  windowDays: number;
  jumpDposKm: number;
  jumpDaKm: number;
  /** propagation policy for B* = 0 sets (propagator-policy.ts); absent = SGP4 for every set (production) */
  sgp?: SgpPolicy;
  /** typical position error of the era's sets with the era's model (chain check), written to coverage manifests and jump payloads */
  accuracy?: PositionAccuracy;
  note?: string;
}

/** SGP for every B* = 0 set (the sets of this era were generated for SGP) */
const SGP_ERA = { minDriftKmD2: 0, deepSpace: true } as const;
/** mixed era: SGP only for near-Earth B* = 0 sets with real drag (2 pi a |ndot/2| >= 3 km/day^2) */
const SGP_LATE = { minDriftKmD2: 3, deepSpace: false } as const;
const ACC_BASIS = 'chain check, era model: set propagated to the next set (<= 5 d later), whole year';
/** accuracy(median km, p95 km) */
const acc = (medianKm: number, p95Km: number): PositionAccuracy => ({ medianKm, p95Km, basis: ACC_BASIS });
/** Ascending by fromYear. Measured (see the header); the 1980 row is production. */
export const ERA_TABLE: readonly EraSettings[] = [
  { fromYear: 1959, windowDays: 34, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 15, sgp: SGP_ERA, accuracy: acc(1024, 13526) },
  { fromYear: 1960, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 15, sgp: SGP_ERA, accuracy: acc(443, 2426) },
  { fromYear: 1961, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 15, sgp: SGP_ERA, accuracy: acc(182, 3783) },
  { fromYear: 1962, windowDays: 61, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 20, sgp: SGP_ERA, accuracy: acc(999, 12920) },
  { fromYear: 1963, windowDays: 93, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 50, sgp: SGP_ERA, accuracy: acc(661, 2624) },
  { fromYear: 1964, windowDays: 87, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 10, sgp: SGP_ERA, accuracy: acc(181, 2664) },
  { fromYear: 1965, windowDays: 49, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 10, sgp: SGP_ERA, accuracy: acc(79, 808) },
  { fromYear: 1966, windowDays: 88, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 75, sgp: SGP_ERA, accuracy: acc(58, 397) },
  { fromYear: 1967, windowDays: 41, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 150, sgp: SGP_ERA, accuracy: acc(78, 854) },
  { fromYear: 1968, windowDays: 58, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 100, sgp: SGP_ERA, accuracy: acc(97, 966) },
  { fromYear: 1969, windowDays: 47, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 150, sgp: SGP_ERA, accuracy: acc(85, 1306) },
  { fromYear: 1970, windowDays: 31, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 30, sgp: SGP_ERA, accuracy: acc(17, 240) },
  { fromYear: 1971, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 5, sgp: SGP_ERA, accuracy: acc(11, 126) },
  { fromYear: 1972, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 7, sgp: SGP_ERA, accuracy: acc(12, 136) },
  { fromYear: 1973, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 7, sgp: SGP_LATE, accuracy: acc(9.9, 96) },
  { fromYear: 1974, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 2, sgp: SGP_LATE, accuracy: acc(9.5, 72) },
  { fromYear: 1975, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 1, sgp: SGP_LATE, accuracy: acc(9.1, 51) },
  { fromYear: 1976, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 1.5, sgp: SGP_LATE, accuracy: acc(10, 60) },
  { fromYear: 1977, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 2, sgp: SGP_LATE, accuracy: acc(11, 50) },
  { fromYear: 1978, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 1.5, sgp: SGP_LATE, accuracy: acc(11, 59) },
  { fromYear: 1979, windowDays: 30, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: 1.5, sgp: SGP_LATE, accuracy: acc(8.6, 61) },
  { fromYear: 1980, windowDays: CATALOG_WINDOW_DAYS, jumpDposKm: JUMP_DPOS_KM, jumpDaKm: JUMP_DA_KM, note: 'production values (SGP4 only)' },
];

export function validateEraTable(t: readonly EraSettings[]): readonly EraSettings[] {
  if (!t.length) throw new Error('era table is empty');
  for (let i = 0; i < t.length; i++) {
    const r = t[i]!;
    if (![r.fromYear, r.windowDays, r.jumpDposKm, r.jumpDaKm].every(Number.isFinite) || r.windowDays < 1) throw new Error(`era table row ${i}: bad numbers`);
    if (i > 0 && r.fromYear <= t[i - 1]!.fromYear) throw new Error('era table must ascend by fromYear');
    if (r.sgp !== undefined && !(Number.isFinite(r.sgp.minDriftKmD2) && r.sgp.minDriftKmD2 >= 0 && typeof r.sgp.deepSpace === 'boolean')) throw new Error(`era table row ${i}: bad sgp policy`);
    if (r.accuracy !== undefined && !(Number.isFinite(r.accuracy.medianKm) && Number.isFinite(r.accuracy.p95Km) && typeof r.accuracy.basis === 'string')) throw new Error(`era table row ${i}: bad accuracy`);
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
