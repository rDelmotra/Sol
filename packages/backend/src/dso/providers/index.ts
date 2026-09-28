/**
 * DSO provider adapters (JPL Horizons today; factory.ts selects by DsoProvider).
 *
 * Owns:
 * - source-specific adapters for DSO truth providers
 * - provider-facing fetch contracts
 *
 * Does not own:
 * - Express integration
 * - cache files
 * - manifests
 * - route response shaping
 * - imports from TLE-specific types or updater logic
 */
export * from './types.js';
export * from './horizons.js';
export * from './factory.js';
