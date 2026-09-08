// ============================================================
// packages/backend/src/analytic — the P3 server executor's backend namespace.
// Spec: my_plans/marvin/perceptor_p3_server_executor.md §2 + p3/S0_contracts_registry.md
// + p3/S2_catalog_provider_universe_all.md Part C + p3/S3_sgp4_provider_astro.md.
//
// Real chain composition: `live` = catalog spine + [catalog, enrichment, sgp4];
// `all` = all-spine spine + [catalog, all-spine, enrichment] (no sgp4 — V-PLANE
// already refuses live-plane refs under universe 'all' at validate time, so the
// registry never sees them). The /api/query/ask route (S4) is the first caller
// of buildSource(). Nothing here wires into backend/src/index.ts's request path yet.
// ============================================================

export * from './types.js';
export { DataSourceRegistry } from './registry.js';
export { createServerSource } from './server-source.js';

import { DataSourceRegistry } from './registry.js';
import { createCatalogProvider, createAllSpineProvider } from './providers/catalog.js';
import { createEnrichmentProvider } from './providers/enrichment.js';
import { createSgp4Provider } from './providers/sgp4.js';
import { createSpaceWeatherProvider } from './providers/space-weather.js';

let singleton: DataSourceRegistry | null = null;

/**
 * Lazy singleton composing the real provider chains.
 *
 * Chain-order rationale (first-non-null semantics from S0):
 * - `live`: catalog first — its facets carry the cron's live-name program
 *   fallback and it's a single Map hit; enrichment fills the 19
 *   client-unserved statics + anything the cron didn't inline; sgp4 last,
 *   claiming only the live-plane fields (speedKmS/altitudeKm/latDeg/lonDeg/
 *   eclipsed) neither other provider serves.
 * - `all`: catalog first (an on-orbit object's elements/name are live
 *   truth), all-spine second (dead-object identity — the only field it
 *   claims that catalog also claims is `name`), enrichment last (deep
 *   statics for everyone, including the countryCode/launchDate/launchYear
 *   fallback for objects neither provider above resolved).
 */
export function getAnalyticRegistry(): DataSourceRegistry {
  if (!singleton) {
    const registry = new DataSourceRegistry();
    const catalog = createCatalogProvider();
    const allSpine = createAllSpineProvider();
    const enrichment = createEnrichmentProvider();
    const sgp4 = createSgp4Provider();
    // One shared instance across both universes — it's a single global,
    // noradId-ignorant provider (see space-weather.ts), so there's no
    // per-universe state to keep separate, and reusing it avoids racing two
    // independent background NOAA refreshes.
    const spaceWeather = createSpaceWeatherProvider();

    registry.registerSpine('live', catalog);
    registry.register('live', catalog);
    registry.register('live', enrichment);
    registry.register('live', sgp4);
    registry.register('live', spaceWeather);

    registry.registerSpine('all', allSpine);
    registry.register('all', catalog);
    registry.register('all', allSpine);
    registry.register('all', enrichment);
    registry.register('all', spaceWeather);

    singleton = registry;
  }
  return singleton;
}
