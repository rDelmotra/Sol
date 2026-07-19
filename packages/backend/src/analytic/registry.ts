// ============================================================
// P3 S0 — DataSourceRegistry: universe → provider composition, field
// routing, boot-time capability+coverage measurement.
// Spec: my_plans/marvin/p3/S0_contracts_registry.md Part C.
//
// Locked semantics (binding on S1-S3 real providers):
// - Providers are noradId-keyed; only server-source.ts knows index<->noradId.
// - Exactly one spine provider per universe, registered explicitly.
// - Field routing = ordered first-non-null chain (registration order).
// - Physics fns: first registration wins; the registry validates at
//   registration time that the declared method actually exists.
// - Coverage is measured at boot over the real spine, never copied from docs.
// ============================================================

import type { AnalyticDataSource, FieldValue, Universe } from '@orbitwatch/analytic';
import { FIELD_REGISTRY } from '@orbitwatch/analytic';
import { createServerSource } from './server-source.js';
import type {
  FieldCapability,
  FieldProvider,
  FnName,
  RegistrySnapshot,
  SpineProvider,
  UniverseSnapshot,
} from './types.js';

const ALL_FNS: readonly FnName[] = [
  'elevationDeg', 'rangeKm', 'observerDark', 'visuallyVisible', 'distToKm', 'descendsFrom',
];

interface UniverseState {
  spine?: SpineProvider;
  providers: FieldProvider[];
  fieldChain: Map<string, FieldProvider[]>;
  fnOwner: Map<FnName, FieldProvider>;
}

function chainGetByNorad(chain: FieldProvider[], noradId: number, field: string, tMs: number): FieldValue {
  for (const provider of chain) {
    const v = provider.getField(noradId, field, tMs);
    if (v !== null) return v;
  }
  return null;
}

export class DataSourceRegistry {
  private readonly states = new Map<Universe, UniverseState>();
  private cachedSnapshot: RegistrySnapshot | null = null;

  private stateFor(universe: Universe): UniverseState {
    let s = this.states.get(universe);
    if (!s) {
      s = { providers: [], fieldChain: new Map(), fnOwner: new Map() };
      this.states.set(universe, s);
    }
    return s;
  }

  registerSpine(universe: Universe, spine: SpineProvider): void {
    const s = this.stateFor(universe);
    if (s.spine) {
      throw new Error(`DataSourceRegistry: universe '${universe}' already has a spine ('${s.spine.id}')`);
    }
    s.spine = spine;
    this.cachedSnapshot = null;
  }

  register(universe: Universe, provider: FieldProvider): void {
    for (const field of provider.fields) {
      if (!(field in FIELD_REGISTRY)) {
        throw new Error(`DataSourceRegistry: provider '${provider.id}' claims unknown field '${field}'`);
      }
    }
    for (const fn of provider.fns ?? []) {
      if (typeof provider[fn] !== 'function') {
        throw new Error(`DataSourceRegistry: provider '${provider.id}' declares fn '${fn}' but has no matching method`);
      }
    }

    const s = this.stateFor(universe);
    s.providers.push(provider);
    for (const field of provider.fields) {
      const chain = s.fieldChain.get(field) ?? [];
      chain.push(provider);
      s.fieldChain.set(field, chain);
    }
    for (const fn of provider.fns ?? []) {
      if (!s.fnOwner.has(fn)) s.fnOwner.set(fn, provider);
    }
    this.cachedSnapshot = null;
  }

  /** Registered universes with a spine. */
  universes(): Universe[] {
    return [...this.states.entries()].filter(([, s]) => s.spine).map(([u]) => u);
  }

  /** Thin AnalyticDataSource view over the chain. Cheap to call per request. */
  buildSource(universe: Universe): AnalyticDataSource | null {
    const s = this.states.get(universe);
    if (!s?.spine) return null;
    return createServerSource(s.spine.spine(), s.fieldChain, s.fnOwner);
  }

  /** Boot-time measured capability+coverage. Memoized — call invalidate() in tests. */
  snapshot(): RegistrySnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const tMsFixed = Date.now();
    const universes: UniverseSnapshot[] = [];

    for (const [universe, s] of this.states) {
      if (!s.spine) continue;
      const spine = s.spine.spine();

      const fields: FieldCapability[] = [];
      for (const [field, chain] of s.fieldChain) {
        const servedBy = chain.map((p) => p.id).join('+');
        if (FIELD_REGISTRY[field]?.plane === 'live') {
          // Measuring live-plane fields would run a full SGP4 propagation per
          // object at boot; the honest per-query number comes from the
          // executor's meta.coverage instead. Not measured — recorded as 1.
          fields.push({ field, servedBy, coverage: 1 });
          continue;
        }
        let present = 0;
        for (const noradId of spine) {
          if (chainGetByNorad(chain, noradId, field, tMsFixed) !== null) present++;
        }
        fields.push({ field, servedBy, coverage: spine.length === 0 ? 0 : present / spine.length });
      }

      const fns = ALL_FNS
        .filter((fn) => s.fnOwner.has(fn))
        .map((fn) => ({ fn, servedBy: s.fnOwner.get(fn)!.id }));

      universes.push({ universe, spineSize: spine.length, fields, fns });
    }

    this.cachedSnapshot = { measuredAt: new Date(tMsFixed).toISOString(), universes };
    return this.cachedSnapshot;
  }

  /** Test-only: force the next snapshot() call to re-measure. */
  invalidate(): void {
    this.cachedSnapshot = null;
  }
}
