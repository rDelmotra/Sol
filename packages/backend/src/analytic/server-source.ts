// ============================================================
// P3 S0 — server-source.ts: registry chain → AnalyticDataSource adapter.
// Spec: my_plans/marvin/p3/S0_contracts_registry.md Part D.
//
// A thin, stateless view over an already-built provider chain — providers
// own their own caches, so constructing one of these per request is free.
// ============================================================

import type { AnalyticDataSource, FieldValue, ResolvedObserver } from '@orbitwatch/analytic';
import type { FieldProvider, FnName } from './types.js';

export function createServerSource(
  spine: readonly number[],
  fieldChain: Map<string, FieldProvider[]>,
  fnOwner: Map<FnName, FieldProvider>,
): AnalyticDataSource {
  const noradToIndex = new Map<number, number>();
  spine.forEach((id, i) => noradToIndex.set(id, i));

  function chainGet(noradId: number, field: string, tMs: number): FieldValue {
    const chain = fieldChain.get(field);
    if (!chain) return null;
    for (const provider of chain) {
      const v = provider.getField(noradId, field, tMs);
      if (v !== null) return v;
    }
    return null;
  }

  return {
    size: () => spine.length,
    noradId: (i) => spine[i],
    noradToIndex: (id) => noradToIndex.get(id),
    getField: (i, field, tMs) => chainGet(spine[i], field, tMs),
    elevationDeg: (i, obs: ResolvedObserver, tMs) => {
      const owner = fnOwner.get('elevationDeg');
      return owner ? (owner.elevationDeg!(spine[i], obs, tMs) ?? null) : null;
    },
    rangeKm: (i, obs, tMs) => {
      const owner = fnOwner.get('rangeKm');
      return owner ? (owner.rangeKm!(spine[i], obs, tMs) ?? null) : null;
    },
    observerDark: (obs, tMs) => {
      const owner = fnOwner.get('observerDark');
      return owner ? (owner.observerDark!(obs, tMs) ?? null) : null;
    },
    visuallyVisible: (i, obs, tMs) => {
      const owner = fnOwner.get('visuallyVisible');
      return owner ? (owner.visuallyVisible!(spine[i], obs, tMs) ?? null) : null;
    },
    distToKm: (i, targetNoradId, tMs) => {
      const owner = fnOwner.get('distToKm');
      return owner ? (owner.distToKm!(spine[i], targetNoradId, tMs) ?? null) : null;
    },
    descendsFrom: (i, ancestorNoradId) => {
      const owner = fnOwner.get('descendsFrom');
      return owner ? owner.descendsFrom!(spine[i], ancestorNoradId) : false;
    },
  };
}
