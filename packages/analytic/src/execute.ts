// ============================================================
// Analytic IR v1 — executor (browser interpreter, spec §2–§7).
//
// Executes a VALIDATED AnalyticProgram (callers run validateProgram first)
// against an AnalyticDataSource — the port behind which the real adapters
// live (live worker buffers + catalog + entity maps; a test fixture here).
// The executor owns only pipeline mechanics: relations, expression
// evaluation, aggregation, and the structural-honesty bookkeeping
// (meta.coverage from the nulls it actually skipped).
//
// Null semantics (spec §3): arithmetic/comparison touching null yields null;
// filters keep only strictly-true rows; aggregates skip nulls and report the
// basis. Coverage is recorded during filter/derive/aggregate/groupBy scans
// (one count per field per row), not during sort or output materialization.
//
// Time: one instant per program. timeScan is the only construct that
// evaluates at other instants, which is why source methods take tMs.
// ============================================================

import type {
  AnalyticProgram,
  AnalyticResult,
  CoverageEntry,
  Expr,
  Agg,
  Stage,
  ObserverRef,
  Universe,
} from './types.js';
import { MAX_GROUPS } from './validate.js';

// ── Data-source port ──────────────────────────────────────────────────────────

export type FieldValue = number | string | boolean | string[] | null;

export interface ResolvedObserver {
  latDeg: number;
  lonDeg: number;
  altKm?: number;
}

export interface AnalyticDataSource {
  size(): number;
  /** noradId of the object at source index i. */
  noradId(i: number): number;
  noradToIndex(noradId: number): number | undefined;
  /** Base + derived registry field access at instant tMs. Unknown/absent → null. */
  getField(i: number, field: string, tMs: number): FieldValue;
  elevationDeg(i: number, obs: ResolvedObserver, tMs: number): number | null;
  rangeKm(i: number, obs: ResolvedObserver, tMs: number): number | null;
  observerDark(obs: ResolvedObserver, tMs: number): boolean | null;
  visuallyVisible(i: number, obs: ResolvedObserver, tMs: number): boolean | null;
  distToKm(i: number, targetNoradId: number, tMs: number): number | null;
  descendsFrom(i: number, ancestorNoradId: number): boolean;
}

export interface ExecuteOptions {
  /** Wall/sim clock for timeBinding 'now'. Tests pass a fixed value. */
  nowMs?: number;
  /** Resolution of ObserverRef 'user'. Absent + 'user' referenced → E-OBSERVER. */
  observer?: ResolvedObserver | null;
}

export type RuntimeErrorCode = 'E-OBSERVER' | 'E-UNIVERSE' | 'E-GROUP' | 'E-INTERNAL';

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
}

export type ExecuteOutcome =
  | { ok: true; result: AnalyticResult }
  | { ok: false; error: RuntimeError };

class ExecError extends Error {
  constructor(public code: RuntimeErrorCode, message: string) {
    super(message);
  }
}

// ── Relations ─────────────────────────────────────────────────────────────────

interface ObjRel {
  kind: 'objects';
  idx: number[];
  derived: Map<string, FieldValue[]>;
}

interface GrpRel {
  kind: 'groups';
  rows: Record<string, FieldValue>[];
  aggregated: boolean;
  timeScanned: boolean;
}

type Relation = ObjRel | GrpRel;

// ── Executor ──────────────────────────────────────────────────────────────────

export function execute(
  program: AnalyticProgram,
  sources: { live: AnalyticDataSource; all?: AnalyticDataSource },
  opts?: ExecuteOptions,
): ExecuteOutcome {
  try {
    return { ok: true, result: new Runner(program, sources, opts).run() };
  } catch (err) {
    if (err instanceof ExecError) return { ok: false, error: { code: err.code, message: err.message } };
    return { ok: false, error: { code: 'E-INTERNAL', message: err instanceof Error ? err.message : String(err) } };
  }
}

class Runner {
  private readonly source: AnalyticDataSource;
  private readonly universe: Universe;
  private readonly tMs: number;
  private readonly observer: ResolvedObserver | null;
  /** Per-field coverage — keep the scan with the largest basis per field. */
  private readonly coverage = new Map<string, { present: number; total: number }>();
  /** Per-row read tracking (field → non-null), folded after each row scan. */
  private rowReads: Map<string, boolean> | null = null;
  private readonly clipped: string[] = [];
  private missingIds: number[] | undefined;

  constructor(
    private readonly program: AnalyticProgram,
    sources: { live: AnalyticDataSource; all?: AnalyticDataSource },
    opts?: ExecuteOptions,
  ) {
    this.universe = program.universe;
    const src = program.universe === 'all' ? sources.all : sources.live;
    if (!src) throw new ExecError('E-UNIVERSE', `no data source for universe '${program.universe}'`);
    this.source = src;
    const nowMs = opts?.nowMs ?? Date.now();
    this.tMs = program.timeBinding.mode === 'at' ? Date.parse(program.timeBinding.t) : nowMs;
    this.observer = opts?.observer ?? null;
  }

  run(): AnalyticResult {
    const scanned = this.source.size();
    let rel: Relation = {
      kind: 'objects',
      idx: Array.from({ length: scanned }, (_, i) => i),
      derived: new Map(),
    };
    for (const stage of this.program.pipeline) rel = this.runStage(rel, stage);

    let compare: AnalyticResult | undefined;
    if (this.program.compare) {
      const sub = new Runner(
        { ...this.program, pipeline: this.program.compare.pipeline, compare: undefined },
        { live: this.source, all: this.source },
        { nowMs: this.tMs, observer: this.observer },
      );
      compare = sub.runAsCompare();
    }

    return this.materialize(rel, scanned, compare);
  }

  /** Compare pipelines have no OutputSpec — infer the natural shape. */
  private runAsCompare(): AnalyticResult {
    const scanned = this.source.size();
    let rel: Relation = {
      kind: 'objects',
      idx: Array.from({ length: scanned }, (_, i) => i),
      derived: new Map(),
    };
    for (const stage of this.program.pipeline) rel = this.runStage(rel, stage);
    const inferred: AnalyticProgram['output'] =
      rel.kind === 'groups' && rel.aggregated && Object.keys(rel.rows[0] ?? {}).length === 1
        ? { shape: 'scalar' }
        : rel.kind === 'groups'
          ? { shape: 'grouped' }
          : { shape: 'ids' };
    return this.materialize(rel, scanned, undefined, inferred);
  }

  // ── Stages ──────────────────────────────────────────────────────────────────

  private runStage(rel: Relation, stage: Stage): Relation {
    switch (stage.op) {
      case 'pick': {
        const idx: number[] = [];
        const missing: number[] = [];
        for (const id of stage.ids) {
          const i = this.source.noradToIndex(id);
          if (i === undefined) missing.push(id);
          else idx.push(i);
        }
        if (missing.length > 0) this.missingIds = missing;
        // pick REPLACES the relation (spec §2) — prior derived columns drop.
        return { kind: 'objects', idx, derived: new Map() };
      }
      case 'filter': {
        if (rel.kind === 'groups') {
          return { ...rel, rows: rel.rows.filter((row) => this.evalGrp(stage.where, row) === true) };
        }
        const keep: number[] = [];
        for (let pos = 0; pos < rel.idx.length; pos++) {
          this.beginRow();
          const v = this.evalObj(stage.where, rel, pos, this.tMs);
          this.endRow();
          if (v === true) keep.push(pos);
        }
        return this.compact(rel, keep);
      }
      case 'derive': {
        if (rel.kind === 'groups') throw new ExecError('E-INTERNAL', 'derive on a grouped relation');
        for (const [name, expr] of Object.entries(stage.fields)) {
          const col: FieldValue[] = new Array(rel.idx.length);
          for (let pos = 0; pos < rel.idx.length; pos++) {
            this.beginRow();
            col[pos] = this.evalObj(expr, rel, pos, this.tMs);
            this.endRow();
          }
          rel.derived.set(name, col);
        }
        return rel;
      }
      case 'sort': {
        const dirMul = stage.dir === 'desc' ? -1 : 1;
        if (rel.kind === 'groups') {
          const rows = [...rel.rows].sort((a, b) => compareValues(a[stage.by] ?? null, b[stage.by] ?? null, dirMul));
          return { ...rel, rows };
        }
        const order = rel.idx.map((_, pos) => pos);
        // No coverage recording during sort — reads here would inflate the basis.
        const key = (pos: number): FieldValue => this.getVal(rel, pos, stage.by, this.tMs, false);
        order.sort((a, b) => compareValues(key(a), key(b), dirMul));
        return this.compact(rel, order);
      }
      case 'limit': {
        if (rel.kind === 'groups') return { ...rel, rows: rel.rows.slice(0, stage.n) };
        return this.compact(rel, rel.idx.map((_, pos) => pos).slice(0, stage.n));
      }
      case 'aggregate': {
        if (rel.kind === 'groups') throw new ExecError('E-INTERNAL', 'aggregate on a grouped relation');
        const positions = rel.idx.map((_, pos) => pos);
        const row: Record<string, FieldValue> = {};
        for (const [name, agg] of Object.entries(stage.aggs)) {
          row[name] = this.computeAgg(agg, rel, positions);
        }
        return { kind: 'groups', rows: [row], aggregated: true, timeScanned: false };
      }
      case 'groupBy': {
        if (rel.kind === 'groups') throw new ExecError('E-INTERNAL', 'groupBy on a grouped relation');
        const keys = typeof stage.key === 'string' ? [stage.key] : stage.key;
        const groups = new Map<string, { keyVals: FieldValue[]; positions: number[] }>();
        for (let pos = 0; pos < rel.idx.length; pos++) {
          this.beginRow();
          const keyVals = keys.map((k) => this.getVal(rel, pos, k, this.tMs, true));
          this.endRow();
          const mapKey = JSON.stringify(keyVals);
          let g = groups.get(mapKey);
          if (!g) {
            if (groups.size >= MAX_GROUPS) {
              throw new ExecError('E-GROUP', `more than ${MAX_GROUPS} groups for key '${keys.join(',')}'`);
            }
            g = { keyVals, positions: [] };
            groups.set(mapKey, g);
          }
          g.positions.push(pos);
        }
        const rows: Record<string, FieldValue>[] = [];
        for (const g of groups.values()) {
          const row: Record<string, FieldValue> = {};
          keys.forEach((k, i) => { row[k] = g.keyVals[i]; });
          for (const [name, agg] of Object.entries(stage.aggs)) {
            row[name] = this.computeAgg(agg, rel, g.positions);
          }
          rows.push(row);
        }
        return { kind: 'groups', rows, aggregated: false, timeScanned: false };
      }
      case 'timeScan': {
        if (rel.kind === 'groups') throw new ExecError('E-INTERNAL', 'timeScan on a grouped relation');
        const stepMs = stage.stepMinutes * 60_000;
        const sign = stage.direction === 'forward' ? 1 : -1;
        const rows: Record<string, FieldValue>[] = [];
        for (let pos = 0; pos < rel.idx.length; pos++) {
          let minutes: number | null = null;
          for (let k = 0; k <= stage.maxSteps; k++) {
            const t = this.tMs + sign * k * stepMs;
            if (this.evalObj(stage.predicate, rel, pos, t) === true) {
              minutes = k * stage.stepMinutes;
              break;
            }
          }
          const norad = this.source.noradId(rel.idx[pos]);
          if (minutes === null) this.clipped.push(`timeScan exhausted ${stage.maxSteps} steps for ${norad}`);
          rows.push({
            noradId: norad,
            name: this.source.getField(rel.idx[pos], 'name', this.tMs),
            minutesUntil: minutes,
          });
        }
        return { kind: 'groups', rows, aggregated: false, timeScanned: true };
      }
    }
  }

  // ── Aggregation ─────────────────────────────────────────────────────────────

  private computeAgg(agg: Agg, rel: ObjRel, positions: number[]): FieldValue {
    if (agg.fn === 'count') return positions.length;
    if (agg.fn === 'share') {
      let hits = 0;
      for (const pos of positions) {
        this.beginRow();
        if (this.evalObj(agg.where, rel, pos, this.tMs) === true) hits++;
        this.endRow();
      }
      return positions.length === 0 ? null : hits / positions.length;
    }
    const nums: number[] = [];
    let present = 0;
    for (const pos of positions) {
      const v = this.getVal(rel, pos, agg.of, this.tMs, false);
      if (typeof v === 'number') { nums.push(v); present++; }
    }
    this.recordCoverage(agg.of, present, positions.length);
    if (nums.length === 0) return null;
    switch (agg.fn) {
      case 'sum': return nums.reduce((a, b) => a + b, 0);
      case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
      case 'min': return Math.min(...nums);
      case 'max': return Math.max(...nums);
      case 'median': {
        const s = [...nums].sort((a, b) => a - b);
        const mid = s.length >> 1;
        return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
      }
      case 'stddev': {
        // Population stddev.
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length);
      }
    }
  }

  // ── Expression evaluation (object relations) ────────────────────────────────

  private evalObj(e: Expr, rel: ObjRel, pos: number, tMs: number): FieldValue {
    if ('op' in e) {
      switch (e.op) {
        case '+': case '-': case '*': case '/': {
          const a = this.evalObj(e.args[0], rel, pos, tMs);
          const b = this.evalObj(e.args[1], rel, pos, tMs);
          if (typeof a !== 'number' || typeof b !== 'number') return null;
          if (e.op === '+') return a + b;
          if (e.op === '-') return a - b;
          if (e.op === '*') return a * b;
          return b === 0 ? null : a / b;
        }
        case '>': case '>=': case '<': case '<=': case '==': case '!=': {
          const a = this.evalObj(e.args[0], rel, pos, tMs);
          const b = this.evalObj(e.args[1], rel, pos, tMs);
          return compareOp(e.op, a, b);
        }
        case 'and': {
          let sawNull = false;
          for (const arg of e.args) {
            const v = this.evalObj(arg, rel, pos, tMs);
            if (v === false) return false;
            if (v !== true) sawNull = true;
          }
          return sawNull ? null : true;
        }
        case 'or': {
          let sawNull = false;
          for (const arg of e.args) {
            const v = this.evalObj(arg, rel, pos, tMs);
            if (v === true) return true;
            if (v !== false) sawNull = true;
          }
          return sawNull ? null : false;
        }
        case 'not': {
          const v = this.evalObj(e.arg, rel, pos, tMs);
          return typeof v === 'boolean' ? !v : null;
        }
        case 'abs': {
          const v = this.evalObj(e.arg, rel, pos, tMs);
          return typeof v === 'number' ? Math.abs(v) : null;
        }
        case 'bucket': {
          const v = this.evalObj(e.arg, rel, pos, tMs);
          return typeof v === 'number' ? Math.floor(v / e.width) * e.width : null;
        }
        case 'in': {
          const v = this.getVal(rel, pos, e.field, tMs, true);
          if (v === null || Array.isArray(v)) return v === null ? null : false;
          return (e.values as (string | number | boolean)[]).includes(v);
        }
        case 'has': {
          const v = this.getVal(rel, pos, e.field, tMs, true);
          return Array.isArray(v) ? v.includes(e.value) : null;
        }
      }
    }
    if ('fn' in e) {
      const i = rel.idx[pos];
      switch (e.fn) {
        case 'elevationDeg': return this.source.elevationDeg(i, this.resolveObserver(e.observer), tMs);
        case 'rangeKm': return this.source.rangeKm(i, this.resolveObserver(e.observer), tMs);
        case 'observerDark': return this.source.observerDark(this.resolveObserver(e.observer), tMs);
        case 'visuallyVisible': return this.source.visuallyVisible(i, this.resolveObserver(e.observer), tMs);
        case 'distToKm': return this.source.distToKm(i, e.target, tMs);
        case 'descendsFrom': return this.source.descendsFrom(i, e.ancestor);
      }
    }
    if ('field' in e) return this.getVal(rel, pos, e.field, tMs, true);
    if ('lit' in e) return e.lit;
    throw new ExecError('E-INTERNAL', 'unreachable expression shape');
  }

  /** Expression evaluation on group rows (post-groupBy filter/HAVING). */
  private evalGrp(e: Expr, row: Record<string, FieldValue>): FieldValue {
    if ('op' in e) {
      switch (e.op) {
        case '+': case '-': case '*': case '/': case '>': case '>=': case '<': case '<=':
        case '==': case '!=': {
          const a = this.evalGrp(e.args[0], row);
          const b = this.evalGrp(e.args[1], row);
          if (e.op === '==' || e.op === '!=' || e.op === '>' || e.op === '>=' || e.op === '<' || e.op === '<=') {
            return compareOp(e.op, a, b);
          }
          if (typeof a !== 'number' || typeof b !== 'number') return null;
          if (e.op === '+') return a + b;
          if (e.op === '-') return a - b;
          if (e.op === '*') return a * b;
          return b === 0 ? null : a / b;
        }
        case 'and': case 'or': case 'not': case 'abs': case 'bucket': {
          if (e.op === 'not') { const v = this.evalGrp(e.arg, row); return typeof v === 'boolean' ? !v : null; }
          if (e.op === 'abs') { const v = this.evalGrp(e.arg, row); return typeof v === 'number' ? Math.abs(v) : null; }
          if (e.op === 'bucket') { const v = this.evalGrp(e.arg, row); return typeof v === 'number' ? Math.floor(v / e.width) * e.width : null; }
          const vals = e.args.map((a) => this.evalGrp(a, row));
          if (e.op === 'and') return vals.every((v) => v === true) ? true : vals.includes(false) ? false : null;
          return vals.includes(true) ? true : vals.every((v) => v === false) ? false : null;
        }
        case 'in': {
          const v = row[e.field] ?? null;
          if (v === null || Array.isArray(v)) return v === null ? null : false;
          return (e.values as (string | number | boolean)[]).includes(v);
        }
        case 'has': return null;
      }
    }
    if ('fn' in e) throw new ExecError('E-INTERNAL', 'physics functions do not apply to grouped relations');
    if ('field' in e) return row[e.field] ?? null;
    if ('lit' in e) return e.lit;
    throw new ExecError('E-INTERNAL', 'unreachable expression shape');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private resolveObserver(ref: ObserverRef): ResolvedObserver {
    if (ref !== 'user') return ref;
    if (!this.observer) {
      throw new ExecError('E-OBSERVER', 'this question needs your observer location — none is set');
    }
    return this.observer;
  }

  private getVal(rel: ObjRel, pos: number, field: string, tMs: number, record: boolean): FieldValue {
    const col = rel.derived.get(field);
    if (col) return col[pos];
    const v = this.source.getField(rel.idx[pos], field, tMs);
    if (record && this.rowReads) this.rowReads.set(field, v !== null);
    return v;
  }

  private compact(rel: ObjRel, positions: number[]): ObjRel {
    const idx = positions.map((pos) => rel.idx[pos]);
    const derived = new Map<string, FieldValue[]>();
    for (const [name, col] of rel.derived) derived.set(name, positions.map((pos) => col[pos]));
    return { kind: 'objects', idx, derived };
  }

  private beginRow(): void {
    this.rowReads = new Map();
  }

  private endRow(): void {
    if (!this.rowReads) return;
    for (const [field, present] of this.rowReads) {
      const c = this.coverage.get(field) ?? { present: 0, total: 0 };
      c.total += 1;
      if (present) c.present += 1;
      this.coverage.set(field, c);
    }
    this.rowReads = null;
  }

  private recordCoverage(field: string, present: number, total: number): void {
    const prev = this.coverage.get(field);
    // Keep the scan with the largest basis — the most representative denominator.
    if (!prev || total > prev.total) this.coverage.set(field, { present, total });
  }

  // ── Materialization ─────────────────────────────────────────────────────────

  private materialize(
    rel: Relation,
    scanned: number,
    compare: AnalyticResult | undefined,
    outputOverride?: AnalyticProgram['output'],
  ): AnalyticResult {
    const output = outputOverride ?? this.program.output;
    const matched = rel.kind === 'objects' ? rel.idx.length : rel.rows.length;
    const coverage: CoverageEntry[] = [...this.coverage.entries()]
      .filter(([, c]) => c.present < c.total)
      .map(([field, c]) => ({ field, present: c.present, total: c.total }));

    const meta: AnalyticResult['meta'] = {
      interpretation: this.program.interpretation,
      universe: this.universe,
      evaluatedAt: new Date(this.tMs).toISOString(),
      matched,
      scanned,
      coverage,
      ...(this.missingIds ? { missingIds: this.missingIds } : {}),
      ...(this.clipped.length > 0 ? { clipped: this.clipped } : {}),
    };

    switch (output.shape) {
      case 'ids': {
        if (rel.kind !== 'objects') throw new ExecError('E-INTERNAL', `'ids' output on a grouped relation`);
        return { shape: 'ids', ids: Uint32Array.from(rel.idx.map((i) => this.source.noradId(i))), compare, meta };
      }
      case 'grouped': {
        if (rel.kind !== 'groups') throw new ExecError('E-INTERNAL', `'grouped' output on an object relation`);
        return { shape: 'grouped', rows: rel.rows, compare, meta };
      }
      case 'scalar': {
        if (rel.kind !== 'groups') throw new ExecError('E-INTERNAL', `'scalar' output on an object relation`);
        const row = rel.rows[0];
        const value = rel.timeScanned
          ? (row?.minutesUntil as number | null)
          : ((row ? Object.values(row)[0] : null) as number | string | boolean | null);
        return { shape: 'scalar', value: value ?? undefined, compare, meta };
      }
      case 'object':
      case 'table': {
        if (rel.kind !== 'objects') throw new ExecError('E-INTERNAL', `'${output.shape}' output on a grouped relation`);
        const cols = output.columns ?? ['name'];
        const rows = rel.idx.map((i, pos) => {
          const row: Record<string, unknown> = { noradId: this.source.noradId(i) };
          for (const c of cols) row[c] = this.getVal(rel, pos, c, this.tMs, false);
          return row;
        });
        return { shape: output.shape, rows: output.shape === 'object' ? rows.slice(0, 1) : rows, compare, meta };
      }
    }
  }
}

// ── Value comparison (shared by cmp ops and sort) ─────────────────────────────

function compareOp(
  op: '>' | '>=' | '<' | '<=' | '==' | '!=',
  a: FieldValue,
  b: FieldValue,
): boolean | null {
  if (a === null || b === null || Array.isArray(a) || Array.isArray(b)) return null;
  if (op === '==') return a === b;
  if (op === '!=') return a !== b;
  if (typeof a === 'number' && typeof b === 'number') {
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
    if (op === '<') return a < b;
    return a <= b;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    // Dates are ISO strings — lexicographic order is chronological.
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
    if (op === '<') return a < b;
    return a <= b;
  }
  return null;
}

/** Sort comparator: nulls last regardless of direction. */
function compareValues(a: FieldValue, b: FieldValue, dirMul: number): number {
  const aNull = a === null || Array.isArray(a);
  const bNull = b === null || Array.isArray(b);
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * dirMul;
  const as = String(a);
  const bs = String(b);
  return (as < bs ? -1 : as > bs ? 1 : 0) * dirMul;
}
