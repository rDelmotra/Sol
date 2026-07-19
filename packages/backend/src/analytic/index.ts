// ============================================================
// packages/backend/src/analytic — the P3 server executor's backend namespace.
// Spec: my_plans/marvin/perceptor_p3_server_executor.md §2 + p3/S0_contracts_registry.md.
//
// S0 lands the contracts + registry only. Real providers (S1-S3) register
// into getAnalyticRegistry(); the /api/query/ask route (S4) is the first
// caller of buildSource(). Nothing in S0 wires this into backend/src/index.ts.
// ============================================================

export * from './types.js';
export { DataSourceRegistry } from './registry.js';
export { createServerSource } from './server-source.js';

import { DataSourceRegistry } from './registry.js';

let singleton: DataSourceRegistry | null = null;

/** Lazy singleton. S0 leaves it registering nothing — real providers land in S1-S3. */
export function getAnalyticRegistry(): DataSourceRegistry {
  if (!singleton) singleton = new DataSourceRegistry();
  return singleton;
}
