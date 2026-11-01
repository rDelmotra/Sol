/**
 * Encounter screening (SSA): an all-vs-all 36 h screen of the catalog with Foster Pc, persisted to Postgres.
 * Public surface: screenEncounters (pure core), loadCatalogFromDb / fromEnriched, writeRun, runNightly.
 */
export { screenEncounters, S6_SETTINGS, FENCED_IDS } from './screen.js';
export { loadCatalogFromDb, fromEnriched } from './catalog.js';
export { writeRun, SSA_CODE_VERSION } from './writer.js';
export { runNightly, runChanges, SSA_CRON } from './nightly.js';
export type { NightlyOpts, NightlyResult } from './nightly.js';
export type { Encounter, ScreenOpts, ScreenStats, SsaObject } from './types.js';
export { deriveDay, deriveChanges, deriveFormations, loadDayCatalog, loadRecentJumps, writeDayEvents, previousUtcDay } from './events/index.js';
export type { DeriveDayResult, ChangeObject } from './events/index.js';
