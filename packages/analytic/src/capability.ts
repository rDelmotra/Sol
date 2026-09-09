// ============================================================
// Analytic IR v1 — capability annotation layer (P3 S0, spec:
// my_plans/marvin/p3/S0_contracts_registry.md Part A).
//
// NOT part of the frozen IR. Adding/removing a field here never invalidates
// a program; it only changes WHERE it executes (client fast path vs. server
// executor). `CLIENT_SERVED_FIELDS`/`CLIENT_SERVED_FNS` are the ONE routing
// truth — both `frontend/src/query/analytic/live-source.ts` (documents the
// same gaps) and the backend `/api/query/ask` route read them.
// ============================================================

import { FIELD_REGISTRY } from './schema.js';
import type { AnalyticProgram, Expr, Stage, Agg } from './types.js';

/** Fields the frontend live-source adapter returns null for (verified against
 *  live-source.ts's documented "known adapter gaps"). */
export const CLIENT_UNSERVED_FIELDS: ReadonlySet<string> = new Set([
  // Identity (3)
  'jcat', 'parentJcat', 'operationalStatus',
  // Physical (10)
  'launchMassKg', 'dryMassKg', 'totMassKg', 'lengthM', 'diameterM', 'spanM',
  'powerW', 'expectedLifetimeYrs', 'bus', 'shape',
  // Dotted (6)
  'launch.date', 'launch.lvType', 'launch.pad', 'launch.success',
  'owner.stateCode', 'owner.cls',
]);

/** Fns the client serves. descendsFrom is NOT here (live-source returns false). */
export const CLIENT_SERVED_FNS: ReadonlySet<string> = new Set([
  'elevationDeg', 'rangeKm', 'observerDark', 'visuallyVisible', 'distToKm',
]);

/** Every FIELD_REGISTRY key except the client-unserved ones. */
export const CLIENT_SERVED_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(FIELD_REGISTRY).filter((f) => !CLIENT_UNSERVED_FIELDS.has(f)),
);

export interface ProgramRefs {
  fields: Set<string>;
  fns: Set<string>;
}

/** Walk every stage/expr the program can reference a source field/fn through. */
export function collectProgramRefs(program: AnalyticProgram): ProgramRefs {
  const fields = new Set<string>();
  const fns = new Set<string>();
  const derivedLocal = new Set<string>();
  // Once a program crosses aggregate/groupBy, the relation becomes a GROUP
  // relation: later stages (sort/filter/limit, output.columns) reference
  // group-row columns (groupBy keys + agg names) computed in-process, not
  // source fields — so they must not feed the client/server field check.
  let inGroupMode = false;

  function walkExpr(e: Expr): void {
    if ('field' in e) {
      if (!derivedLocal.has(e.field)) fields.add(e.field);
      return;
    }
    if ('lit' in e) return;
    if ('fn' in e) {
      fns.add(e.fn);
      if (e.fn === 'distToKm' || e.fn === 'descendsFrom') return;
      return;
    }
    switch (e.op) {
      case '+': case '-': case '*': case '/':
      case '>': case '>=': case '<': case '<=': case '==': case '!=':
        walkExpr(e.args[0]);
        walkExpr(e.args[1]);
        return;
      case 'and': case 'or':
        for (const a of e.args) walkExpr(a);
        return;
      case 'not': case 'abs':
        walkExpr(e.arg);
        return;
      case 'bucket':
        walkExpr(e.arg);
        return;
      // 'in'/'has' also carry a `field` prop — caught by the `'field' in e`
      // check above (both variants reference a source field the same way).
    }
  }

  function walkAgg(agg: Agg): void {
    if (agg.fn === 'count') return;
    if (agg.fn === 'share') { walkExpr(agg.where); return; }
    if (!derivedLocal.has(agg.of)) fields.add(agg.of);
  }

  function walkStage(stage: Stage): void {
    if (inGroupMode) {
      // Group-relation stages (sort/filter/limit) read computed row columns,
      // never source fields — nothing to collect. (The validator forbids a
      // second aggregate/groupBy/derive/timeScan once grouped.)
      return;
    }
    switch (stage.op) {
      case 'pick':
        return;
      case 'filter':
        walkExpr(stage.where);
        return;
      case 'derive':
        for (const [name, expr] of Object.entries(stage.fields)) {
          walkExpr(expr);
          derivedLocal.add(name);
        }
        return;
      case 'sort':
        if (!derivedLocal.has(stage.by)) fields.add(stage.by);
        return;
      case 'limit':
        return;
      case 'aggregate':
        for (const agg of Object.values(stage.aggs)) walkAgg(agg);
        inGroupMode = true;
        return;
      case 'groupBy': {
        const keys = typeof stage.key === 'string' ? [stage.key] : stage.key;
        for (const k of keys) if (!derivedLocal.has(k)) fields.add(k);
        for (const agg of Object.values(stage.aggs)) walkAgg(agg);
        inGroupMode = true;
        return;
      }
      case 'timeScan':
        walkExpr(stage.predicate);
        return;
      case 'sweep':
        walkExpr(stage.predicate);
        if (stage.peakOf) walkExpr(stage.peakOf);
        return;
    }
  }

  for (const stage of program.pipeline) walkStage(stage);
  // output.columns belongs to the MAIN pipeline's relation, so BOTH pieces of
  // traversal state it reads must reflect the main pipeline, not whatever the
  // compare pipeline (walked below, on its own fresh relation) leaves behind.
  //
  // `inGroupMode` leaking here was a live mis-route (compare aggregates → main's
  // output.columns skipped → a server-only column never collected → the client
  // executes and reads null: a hollow answer produced by the router itself).
  //
  // `derivedLocal` is belt-and-braces: a compare-pipeline `derive` name can't
  // currently collide with a real source field, because validate.ts rejects a
  // derived name that shadows a FIELD_REGISTRY key and gives the compare
  // pipeline its own `derived` map. We scope it anyway rather than let this
  // file's correctness depend on an invariant enforced in another one.
  const mainGroupMode = inGroupMode;
  const mainDerivedLocal = new Set(derivedLocal);
  if (program.compare) {
    inGroupMode = false;
    for (const stage of program.compare.pipeline) walkStage(stage);
  }
  inGroupMode = mainGroupMode;
  derivedLocal.clear();
  for (const n of mainDerivedLocal) derivedLocal.add(n);
  if (program.output.columns && !inGroupMode) {
    for (const c of program.output.columns) if (!derivedLocal.has(c)) fields.add(c);
  }

  return { fields, fns };
}

/** true ⇢ the program must execute server-side. */
export function programNeedsServer(program: AnalyticProgram): boolean {
  if (program.universe === 'all') return true;
  const { fields, fns } = collectProgramRefs(program);
  for (const f of fields) if (!CLIENT_SERVED_FIELDS.has(f)) return true;
  for (const fn of fns) if (!CLIENT_SERVED_FNS.has(fn)) return true;
  return false;
}
