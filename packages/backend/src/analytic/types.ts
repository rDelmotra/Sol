// ============================================================
// P3 S0 — backend analytic namespace: FieldProvider port + registry types.
// Spec: my_plans/marvin/p3/S0_contracts_registry.md Part B.
//
// THE expandability contract: a future domain (weather, incidents, news)
// lands as one new FieldProvider + new FIELD_REGISTRY nouns + prompt regen —
// nothing outside providers/ + registration changes.
// ============================================================

import type { FieldValue, ResolvedObserver, Universe } from '@orbitwatch/analytic';

export type FnName =
  | 'elevationDeg' | 'rangeKm' | 'observerDark'
  | 'visuallyVisible' | 'distToKm' | 'descendsFrom';

export interface FieldProvider {
  /** 'catalog' | 'enrichment' | 'sgp4' | 'fixture:*' */
  readonly id: string;
  /** FIELD_REGISTRY keys this provider can serve. */
  readonly fields: readonly string[];
  /** Physics fns implemented (typed methods below must exist for each declared name). */
  readonly fns?: readonly FnName[];
  /** Value at tMs for the object. Unknown object / absent value → null. FAST for misses. */
  getField(noradId: number, field: string, tMs: number): FieldValue;

  // Optional physics surface — present iff declared in `fns`.
  elevationDeg?(noradId: number, obs: ResolvedObserver, tMs: number): number | null;
  rangeKm?(noradId: number, obs: ResolvedObserver, tMs: number): number | null;
  observerDark?(obs: ResolvedObserver, tMs: number): boolean | null;
  visuallyVisible?(noradId: number, obs: ResolvedObserver, tMs: number): boolean | null;
  distToKm?(noradId: number, targetNoradId: number, tMs: number): number | null;
  descendsFrom?(noradId: number, ancestorNoradId: number): boolean;
}

/** The spine defines the universe's object list. Ordered, deduped noradIds. */
export interface SpineProvider {
  readonly id: string;
  spine(): readonly number[];
}

export interface FieldCapability {
  field: string;
  servedBy: string;
  coverage: number;
}

export interface UniverseSnapshot {
  universe: Universe;
  spineSize: number;
  /** Chain-measured over the real spine. */
  fields: FieldCapability[];
  fns: { fn: FnName; servedBy: string }[];
}

export interface RegistrySnapshot {
  /** ISO — when the boot measurement ran. */
  measuredAt: string;
  universes: UniverseSnapshot[];
}
