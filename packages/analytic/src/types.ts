// ============================================================
// Analytic IR v1 — program types (spec: my_plans/marvin/perceptor_ir_v1.md §1–§7).
//
// A program is a JSON logical query plan: pure data, schema-validatable,
// cacheable by hash, engine-neutral. Any compiler may emit it (tier-0 local
// parser, tier-1 LLM compiler, a hand-written test); one validator gates it;
// executors run it (browser typed-array interpreter first).
//
// Tier rule: @orbitwatch/analytic is the PURE tier — files in this package
// import only each other (no node builtins, no runtime deps, no I/O), so
// everything runs under plain node:test in any consumer (frontend live
// executor, backend prompt-gen/validate) and doubles as the response type
// of POST /api/query/compile. The impure live adapter (live-source.ts, which
// needs orbital/ + data/ + satellite.js) stays in the frontend.
//
// v1 scope: live + static planes. Series/history operators are RESERVED
// (spec §11) and intentionally absent from these unions.
// ============================================================

export type Universe = 'live' | 'all';

/** One instant per program. 'now' = SimClock; pinning = rebind + re-execute. */
export type TimeBinding = { mode: 'now' } | { mode: 'at'; t: string };

export type ResultShape = 'ids' | 'object' | 'table' | 'scalar' | 'grouped';

export interface OutputSpec {
  shape: ResultShape;
  /** For object/table/grouped: base/derived/dotted fields to render. */
  columns?: string[];
}

export interface AnalyticProgram {
  v: 1;
  universe: Universe;
  timeBinding: TimeBinding;
  /** Mandatory: the compiler's stated reading of the question. */
  interpretation: string;
  pipeline: Stage[];
  /** Optional A-vs-B second pipeline; narrator juxtaposes. No cross-refs (v1). */
  compare?: { label: string; pipeline: Stage[] };
  output: OutputSpec;
}

// ── Stages ────────────────────────────────────────────────────────────────────
// Stages transform the current relation: object set → (after groupBy) group set.
// sort/limit/filter after groupBy operate on groups (SQL HAVING for free).

export type SortDir = 'asc' | 'desc';

export interface PickStage { op: 'pick'; ids: number[] }
export interface FilterStage { op: 'filter'; where: Expr }
export interface DeriveStage { op: 'derive'; fields: Record<string, Expr> }
export interface SortStage { op: 'sort'; by: string; dir: SortDir }
export interface LimitStage { op: 'limit'; n: number }
export interface AggregateStage { op: 'aggregate'; aggs: Record<string, Agg> }
export interface GroupByStage { op: 'groupBy'; key: string | string[]; aggs: Record<string, Agg> }
/** Bounded "how long until predicate flips" scan. Final stage only; set ≤ 5. */
export interface TimeScanStage {
  op: 'timeScan';
  predicate: Expr;
  direction: 'forward' | 'backward';
  stepMinutes: number;
  maxSteps: number;
}
/**
 * Forward interval scan: for each object, every window in [t0, t0+horizon] where
 * `predicate` holds. Final stage only. The generalization of timeScan from "first
 * transition, one scalar" to "N objects → interval rows" — a pass predictor is
 * `sweep` with predicate `elevationDeg(obs) > 10` and `peakOf: elevationDeg(obs)`;
 * observers/elevation/"passes" are not baked into the grammar.
 *
 * Forward only — deliberate, not an oversight. A pass predictor is inherently about
 * the future; timeScan already covers backward, so a `direction` field here would
 * double the test surface for a capability nobody asked for.
 */
export interface SweepStage {
  op: 'sweep';
  predicate: Expr;          // bool, evaluated per object per instant
  horizonMinutes: number;   // how far forward to look
  stepSeconds: number;      // coarse sampling interval
  peakOf?: Expr;            // optional numeric expr maximized within each interval
}

export type Stage =
  | PickStage
  | FilterStage
  | DeriveStage
  | SortStage
  | LimitStage
  | AggregateStage
  | GroupByStage
  | TimeScanStage
  | SweepStage;

// ── Aggregates ────────────────────────────────────────────────────────────────

export type AggFieldFn = 'sum' | 'avg' | 'median' | 'min' | 'max' | 'stddev';

export type Agg =
  | { fn: 'count' }
  | { fn: AggFieldFn; of: string }
  /** Fraction of the relation satisfying `where` (evaluated per row). */
  | { fn: 'share'; where: Expr };

// ── Expressions ───────────────────────────────────────────────────────────────

export type ArithOp = '+' | '-' | '*' | '/';
export type CmpOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

/** Observer for the parameterized physics functions. 'user' = store location. */
export type ObserverRef = 'user' | { latDeg: number; lonDeg: number; altKm?: number };

export type FnExpr =
  | { fn: 'elevationDeg'; observer: ObserverRef }
  | { fn: 'rangeKm'; observer: ObserverRef }
  | { fn: 'observerDark'; observer: ObserverRef }
  | { fn: 'visuallyVisible'; observer: ObserverRef }
  | { fn: 'distToKm'; target: number }
  | { fn: 'descendsFrom'; ancestor: number };

export type Expr =
  | { field: string }
  | { lit: number | string | boolean }
  | { op: ArithOp; args: [Expr, Expr] }
  | { op: CmpOp; args: [Expr, Expr] }
  | { op: 'and' | 'or'; args: Expr[] }
  | { op: 'not'; arg: Expr }
  | { op: 'abs'; arg: Expr }
  | { op: 'bucket'; arg: Expr; width: number }
  | { op: 'in'; field: string; values: (string | number)[] }
  | { op: 'has'; field: string; value: string }
  | FnExpr;

// ── Results (executor output; spec §7) ────────────────────────────────────────

export interface CoverageEntry {
  field: string;
  present: number;
  total: number;
}

export interface ResultMeta {
  interpretation: string;
  universe: Universe;
  /** Resolved instant (sim time, ISO). */
  evaluatedAt: string;
  matched: number;
  scanned: number;
  /** Auto-caveat basis — narrator MUST surface entries with present/total < 0.95. */
  coverage: CoverageEntry[];
  missingIds?: number[];
  clipped?: string[];
}

export interface AnalyticResult {
  shape: ResultShape;
  /** 'ids' → globe allow-set. */
  ids?: Uint32Array;
  /** 'table' | 'object' | 'grouped'. */
  rows?: Record<string, unknown>[];
  /** 'scalar'. */
  value?: number | string | boolean;
  compare?: AnalyticResult;
  meta: ResultMeta;
}
