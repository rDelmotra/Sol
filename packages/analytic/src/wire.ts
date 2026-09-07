// ============================================================
// Analytic IR v1 — wire (de)serialization (P3 S4 Part A, spec:
// my_plans/marvin/p3/S4_ask_route.md "Part A").
//
// AnalyticResult.ids is a Uint32Array, which JSON.stringify silently mangles
// (serializes as {"0":..,"1":..} object, not an array). Both the backend
// /api/query/ask route and the frontend client need one shared converter
// pair so the wire shape is defined exactly once.
// ============================================================

import type { AnalyticResult, ResultShape, ResultMeta } from './types.js';

export interface AnalyticResultWire {
  shape: ResultShape;
  ids?: number[];
  rows?: Record<string, unknown>[];
  value?: number | string | boolean;
  compare?: AnalyticResultWire;
  meta: ResultMeta;
}

export function toWireResult(r: AnalyticResult): AnalyticResultWire {
  return {
    shape: r.shape,
    ...(r.ids ? { ids: Array.from(r.ids) } : {}),
    ...(r.rows ? { rows: r.rows } : {}),
    ...(r.value !== undefined ? { value: r.value } : {}),
    ...(r.compare ? { compare: toWireResult(r.compare) } : {}),
    meta: r.meta,
  };
}

export function fromWireResult(w: AnalyticResultWire): AnalyticResult {
  return {
    shape: w.shape,
    ...(w.ids ? { ids: Uint32Array.from(w.ids) } : {}),
    ...(w.rows ? { rows: w.rows } : {}),
    ...(w.value !== undefined ? { value: w.value } : {}),
    ...(w.compare ? { compare: fromWireResult(w.compare) } : {}),
    meta: w.meta,
  };
}
