// ============================================================
// Analytic IR v1 — validator (spec §8).
//
// Validates UNKNOWN input (the LLM compiler's raw JSON, a test's literal)
// structurally + semantically against the field registry, and returns typed
// issues whose codes drive the compile repair loop. Empty issues ⇒ the input
// IS an AnalyticProgram (the only place that cast is allowed).
//
// Everything here is compile-time-cheap and pure: no catalog access, no
// Date.now() unless the caller omits opts.nowMs (tests pass a fixed clock).
// ============================================================

import type { AnalyticProgram, Universe } from './types.js';
import { FIELD_REGISTRY, FN_SPECS, SORTABLE_KINDS, type FieldKind } from './schema.js';

// ── Caps (spec §8) ────────────────────────────────────────────────────────────

export const MAX_PIPELINE_STAGES = 8;
export const MAX_DERIVED_FIELDS = 10;
export const MAX_EXPR_DEPTH = 6;
export const MIN_BOOL_ARITY = 2;
export const MAX_BOOL_ARITY = 8;
export const MAX_IN_VALUES = 50;
export const MAX_LIMIT = 1000;
export const MAX_PICK_IDS = 1000;
export const MAX_TIMESCAN_STEPS = 240;
export const TIMESCAN_MAX_OBJECTS = 5;
/** Runtime group-cardinality guard (executor enforces; exported for it). */
export const MAX_GROUPS = 2000;
export const PAST_CAP_DAYS = 60;
export const FUTURE_CAP_DAYS = 14;

const MS_PER_DAY = 86_400_000;
const DERIVE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

// ── Issue model ───────────────────────────────────────────────────────────────

export type ValidationCode =
  | 'V-SHAPE'   // malformed JSON structure / unknown op / wrong primitive type
  | 'V-PIPE'    // pipeline length / stage-ordering rules
  | 'V-DERIVE'  // too many derived fields
  | 'V-EXPR'    // expression depth / boolean arity
  | 'V-FIELD'   // unknown field / shadowing
  | 'V-TYPE'    // kind mismatch
  | 'V-ENUM'    // value outside an enum domain
  | 'V-PLANE'   // live-plane reference under universe 'all'
  | 'V-TIMECAP' // timeBinding outside the propagation window
  | 'V-SCAN'    // timeScan constraints
  | 'V-GROUP'   // groupBy/aggregate misuse (multi-valued key, double grouping…)
  | 'V-LIMIT'   // limit bounds / unbounded table
  | 'V-OUTPUT'  // output/pipeline inconsistency, unresolvable columns
  | 'V-INTERP'; // missing interpretation

export interface ValidationIssue {
  code: ValidationCode;
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; program: AnalyticProgram }
  | { ok: false; issues: ValidationIssue[] };

// ── Internals ─────────────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x);
}

interface Ctx {
  universe: Universe;
  issues: ValidationIssue[];
  /** Row-level derived fields (name → kind). */
  derived: Map<string, FieldKind>;
  /** Non-null after groupBy: the ONLY namespace (keys + agg names). */
  grouped: Map<string, FieldKind> | null;
  aggregated: boolean;
}

function issue(ctx: Ctx, code: ValidationCode, path: string, message: string): null {
  ctx.issues.push({ code, path, message });
  return null;
}

/** Resolve a field name in the current namespace → kind (records issues). */
function resolveField(ctx: Ctx, name: string, path: string): FieldKind | null {
  if (ctx.grouped) {
    const kind = ctx.grouped.get(name);
    if (kind) return kind;
    return issue(ctx, 'V-FIELD', path, `'${name}' is not a group key or aggregate of the groupBy`);
  }
  const derived = ctx.derived.get(name);
  if (derived) return derived;
  const spec = FIELD_REGISTRY[name];
  if (!spec) return issue(ctx, 'V-FIELD', path, `unknown field '${name}'`);
  if (spec.plane === 'live' && ctx.universe === 'all') {
    return issue(ctx, 'V-PLANE', path, `'${name}' is live-plane; universe 'all' has no live state`);
  }
  return spec.kind;
}

function isNumericKind(k: FieldKind): boolean {
  return k === 'number' || k === 'id';
}

function equalityCompatible(a: FieldKind, b: FieldKind): boolean {
  if (a === b) return true;
  const pair = [a, b].sort().join('|');
  return pair === 'enum|string' || pair === 'date|string' || pair === 'id|number';
}

function checkObserver(ctx: Ctx, obs: unknown, path: string): boolean {
  if (obs === 'user') return true;
  if (isRecord(obs) && typeof obs.latDeg === 'number' && typeof obs.lonDeg === 'number'
    && (obs.altKm === undefined || typeof obs.altKm === 'number')) return true;
  issue(ctx, 'V-SHAPE', path, `observer must be 'user' or {latDeg, lonDeg, altKm?}`);
  return false;
}

/** Type-check an expression tree → its kind (null if any issue was recorded). */
function checkExpr(ctx: Ctx, e: unknown, path: string, depth: number): FieldKind | null {
  if (depth > MAX_EXPR_DEPTH) {
    return issue(ctx, 'V-EXPR', path, `expression deeper than ${MAX_EXPR_DEPTH}`);
  }
  if (!isRecord(e)) return issue(ctx, 'V-SHAPE', path, 'expression must be an object');

  // Dispatch order matters: 'in'/'has' exprs also carry a `field` property, so
  // op-tagged exprs are matched BEFORE the bare-field-ref shape.
  if (!('op' in e) && 'field' in e) {
    if (typeof e.field !== 'string') return issue(ctx, 'V-SHAPE', path, 'field ref must be a string');
    return resolveField(ctx, e.field, path);
  }

  if ('lit' in e) {
    const t = typeof e.lit;
    if (t === 'number') return 'number';
    if (t === 'string') return 'string';
    if (t === 'boolean') return 'bool';
    return issue(ctx, 'V-SHAPE', path, 'lit must be number | string | boolean');
  }

  if ('fn' in e) {
    const spec = typeof e.fn === 'string' ? FN_SPECS[e.fn] : undefined;
    if (!spec) return issue(ctx, 'V-SHAPE', path, `unknown function '${String(e.fn)}'`);
    if (spec.plane === 'live' && ctx.universe === 'all') {
      return issue(ctx, 'V-PLANE', path, `${String(e.fn)}() needs live state; universe is 'all'`);
    }
    if (e.fn === 'distToKm') {
      if (!isInt(e.target)) return issue(ctx, 'V-SHAPE', path, 'distToKm.target must be a noradId int');
    } else if (e.fn === 'descendsFrom') {
      if (!isInt(e.ancestor)) return issue(ctx, 'V-SHAPE', path, 'descendsFrom.ancestor must be a noradId int');
    } else if (!checkObserver(ctx, (e as Record<string, unknown>).observer, `${path}.observer`)) {
      return null;
    }
    return spec.returns;
  }

  if (!('op' in e) || typeof e.op !== 'string') {
    return issue(ctx, 'V-SHAPE', path, 'expression needs field | lit | fn | op');
  }

  switch (e.op) {
    case '+': case '-': case '*': case '/': {
      if (!Array.isArray(e.args) || e.args.length !== 2) {
        return issue(ctx, 'V-SHAPE', path, `'${e.op}' needs exactly 2 args`);
      }
      const kinds = e.args.map((a, i) => checkExpr(ctx, a, `${path}.args[${i}]`, depth + 1));
      if (kinds.includes(null)) return null;
      if (!kinds.every((k) => isNumericKind(k as FieldKind))) {
        return issue(ctx, 'V-TYPE', path, `'${e.op}' needs numeric operands`);
      }
      return 'number';
    }
    case '>': case '>=': case '<': case '<=': case '==': case '!=': {
      if (!Array.isArray(e.args) || e.args.length !== 2) {
        return issue(ctx, 'V-SHAPE', path, `'${e.op}' needs exactly 2 args`);
      }
      const a = checkExpr(ctx, e.args[0], `${path}.args[0]`, depth + 1);
      const b = checkExpr(ctx, e.args[1], `${path}.args[1]`, depth + 1);
      if (a === null || b === null) return null;
      const equality = e.op === '==' || e.op === '!=';
      if (equality) {
        if (!equalityCompatible(a, b)) {
          return issue(ctx, 'V-TYPE', path, `cannot compare ${a} ${e.op} ${b}`);
        }
        // Enum-domain check when one side is a bare enum field, the other a string lit.
        for (const [f, l] of [[e.args[0], e.args[1]], [e.args[1], e.args[0]]] as const) {
          if (isRecord(f) && typeof f.field === 'string' && isRecord(l) && typeof l.lit === 'string') {
            const spec = FIELD_REGISTRY[f.field];
            if (spec?.kind === 'enum' && spec.domain && !spec.domain.includes(l.lit)) {
              return issue(ctx, 'V-ENUM', path, `'${l.lit}' is not in ${f.field}'s domain`);
            }
          }
        }
        return 'bool';
      }
      const orderable =
        (isNumericKind(a) && isNumericKind(b)) ||
        (a === 'date' && (b === 'date' || b === 'string')) ||
        (b === 'date' && a === 'string');
      if (!orderable) return issue(ctx, 'V-TYPE', path, `cannot order ${a} ${e.op} ${b}`);
      return 'bool';
    }
    case 'and': case 'or': {
      if (!Array.isArray(e.args) || e.args.length < MIN_BOOL_ARITY || e.args.length > MAX_BOOL_ARITY) {
        return issue(ctx, 'V-EXPR', path, `'${e.op}' needs ${MIN_BOOL_ARITY}..${MAX_BOOL_ARITY} args`);
      }
      let ok = true;
      e.args.forEach((a, i) => {
        const k = checkExpr(ctx, a, `${path}.args[${i}]`, depth + 1);
        if (k === null) ok = false;
        else if (k !== 'bool') { issue(ctx, 'V-TYPE', `${path}.args[${i}]`, `'${e.op}' args must be bool`); ok = false; }
      });
      return ok ? 'bool' : null;
    }
    case 'not': {
      const k = checkExpr(ctx, e.arg, `${path}.arg`, depth + 1);
      if (k === null) return null;
      if (k !== 'bool') return issue(ctx, 'V-TYPE', path, `'not' needs a bool arg`);
      return 'bool';
    }
    case 'abs': {
      const k = checkExpr(ctx, e.arg, `${path}.arg`, depth + 1);
      if (k === null) return null;
      if (!isNumericKind(k)) return issue(ctx, 'V-TYPE', path, `'abs' needs a numeric arg`);
      return 'number';
    }
    case 'bucket': {
      if (typeof e.width !== 'number' || !(e.width > 0)) {
        return issue(ctx, 'V-TYPE', path, `'bucket' needs width > 0`);
      }
      const k = checkExpr(ctx, e.arg, `${path}.arg`, depth + 1);
      if (k === null) return null;
      if (!isNumericKind(k)) return issue(ctx, 'V-TYPE', path, `'bucket' needs a numeric arg`);
      return 'number';
    }
    case 'in': {
      if (typeof e.field !== 'string') return issue(ctx, 'V-SHAPE', path, `'in' needs a field name`);
      if (!Array.isArray(e.values) || e.values.length < 1 || e.values.length > MAX_IN_VALUES) {
        return issue(ctx, 'V-SHAPE', path, `'in' needs 1..${MAX_IN_VALUES} values`);
      }
      const kind = resolveField(ctx, e.field, path);
      if (kind === null) return null;
      if (kind === 'enum') {
        const domain = FIELD_REGISTRY[e.field]?.domain ?? [];
        for (const v of e.values) {
          if (typeof v !== 'string' || !domain.includes(v)) {
            return issue(ctx, 'V-ENUM', path, `'${String(v)}' is not in ${e.field}'s domain`);
          }
        }
      } else if (kind === 'string' || kind === 'date') {
        if (!e.values.every((v) => typeof v === 'string')) {
          return issue(ctx, 'V-TYPE', path, `'in' values for ${e.field} must be strings`);
        }
      } else if (isNumericKind(kind)) {
        if (!e.values.every((v) => typeof v === 'number')) {
          return issue(ctx, 'V-TYPE', path, `'in' values for ${e.field} must be numbers`);
        }
      } else {
        return issue(ctx, 'V-TYPE', path, `'in' does not apply to ${kind} field '${e.field}' (use 'has')`);
      }
      return 'bool';
    }
    case 'has': {
      if (typeof e.field !== 'string' || typeof e.value !== 'string') {
        return issue(ctx, 'V-SHAPE', path, `'has' needs { field, value } strings`);
      }
      const kind = resolveField(ctx, e.field, path);
      if (kind === null) return null;
      if (kind !== 'enumSet') {
        return issue(ctx, 'V-TYPE', path, `'has' applies to multi-valued fields only; '${e.field}' is ${kind}`);
      }
      const domain = FIELD_REGISTRY[e.field]?.domain ?? [];
      if (!domain.includes(e.value)) {
        return issue(ctx, 'V-ENUM', path, `'${e.value}' is not in ${e.field}'s domain`);
      }
      return 'bool';
    }
    default:
      return issue(ctx, 'V-SHAPE', path, `unknown expression op '${e.op}'`);
  }
}

// ── Aggregates ────────────────────────────────────────────────────────────────

const AGG_FIELD_FNS = ['sum', 'avg', 'median', 'min', 'max', 'stddev'] as const;

function checkAggs(ctx: Ctx, aggs: unknown, path: string): Map<string, FieldKind> | null {
  if (!isRecord(aggs) || Object.keys(aggs).length === 0) {
    issue(ctx, 'V-SHAPE', path, 'aggs must be a non-empty record');
    return null;
  }
  const out = new Map<string, FieldKind>();
  let ok = true;
  for (const [name, agg] of Object.entries(aggs)) {
    const p = `${path}.${name}`;
    if (!DERIVE_NAME_RE.test(name)) { issue(ctx, 'V-SHAPE', p, `bad aggregate name '${name}'`); ok = false; continue; }
    if (!isRecord(agg) || typeof agg.fn !== 'string') { issue(ctx, 'V-SHAPE', p, 'aggregate needs a fn'); ok = false; continue; }
    if (agg.fn === 'count') { out.set(name, 'number'); continue; }
    if (agg.fn === 'share') {
      const k = checkExpr(ctx, agg.where, `${p}.where`, 1);
      if (k === null) { ok = false; continue; }
      if (k !== 'bool') { issue(ctx, 'V-TYPE', `${p}.where`, 'share.where must be bool'); ok = false; continue; }
      out.set(name, 'number');
      continue;
    }
    if ((AGG_FIELD_FNS as readonly string[]).includes(agg.fn)) {
      if (typeof agg.of !== 'string') { issue(ctx, 'V-SHAPE', p, `${agg.fn} needs 'of'`); ok = false; continue; }
      const k = resolveField(ctx, agg.of, p);
      if (k === null) { ok = false; continue; }
      if (!isNumericKind(k)) { issue(ctx, 'V-TYPE', p, `${agg.fn} needs a numeric field; '${agg.of}' is ${k}`); ok = false; continue; }
      out.set(name, 'number');
      continue;
    }
    issue(ctx, 'V-SHAPE', p, `unknown aggregate fn '${agg.fn}'`);
    ok = false;
  }
  return ok ? out : null;
}

// ── Pipeline walk ─────────────────────────────────────────────────────────────

interface PipeState {
  pickCount: number | null;
  limitMin: number | null;
  timeScanUsed: boolean;
  lastAggCount: number;
}

function checkPipeline(ctx: Ctx, pipeline: unknown, path: string): PipeState | null {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    issue(ctx, 'V-SHAPE', path, 'pipeline must be a non-empty array');
    return null;
  }
  if (pipeline.length > MAX_PIPELINE_STAGES) {
    issue(ctx, 'V-PIPE', path, `pipeline longer than ${MAX_PIPELINE_STAGES} stages`);
    return null;
  }
  const state: PipeState = { pickCount: null, limitMin: null, timeScanUsed: false, lastAggCount: 0 };
  let deriveTotal = 0;

  for (let i = 0; i < pipeline.length; i++) {
    const stage = pipeline[i];
    const p = `${path}[${i}]`;
    const final = i === pipeline.length - 1;
    if (!isRecord(stage) || typeof stage.op !== 'string') {
      issue(ctx, 'V-SHAPE', p, 'stage must be an object with an op');
      return null;
    }
    if (ctx.aggregated || state.timeScanUsed) {
      issue(ctx, 'V-PIPE', p, `no stages allowed after ${state.timeScanUsed ? 'timeScan' : 'aggregate'}`);
      return null;
    }

    switch (stage.op) {
      case 'pick': {
        if (ctx.grouped) { issue(ctx, 'V-PIPE', p, 'pick is not allowed after groupBy'); return null; }
        if (!Array.isArray(stage.ids) || stage.ids.length === 0 || stage.ids.length > MAX_PICK_IDS
          || !stage.ids.every(isInt)) {
          issue(ctx, 'V-SHAPE', p, `pick.ids must be 1..${MAX_PICK_IDS} integers`);
          return null;
        }
        state.pickCount = stage.ids.length;
        break;
      }
      case 'filter': {
        const k = checkExpr(ctx, stage.where, `${p}.where`, 1);
        if (k !== null && k !== 'bool') issue(ctx, 'V-TYPE', `${p}.where`, 'filter.where must be bool');
        break;
      }
      case 'derive': {
        if (ctx.grouped) { issue(ctx, 'V-GROUP', p, 'derive is not allowed after groupBy (v1)'); return null; }
        if (!isRecord(stage.fields) || Object.keys(stage.fields).length === 0) {
          issue(ctx, 'V-SHAPE', p, 'derive.fields must be a non-empty record');
          break;
        }
        for (const [name, expr] of Object.entries(stage.fields)) {
          const fp = `${p}.fields.${name}`;
          if (!DERIVE_NAME_RE.test(name)) { issue(ctx, 'V-SHAPE', fp, `bad derived name '${name}'`); continue; }
          if (FIELD_REGISTRY[name] || ctx.derived.has(name)) {
            issue(ctx, 'V-FIELD', fp, `'${name}' shadows an existing field`);
            continue;
          }
          if (++deriveTotal > MAX_DERIVED_FIELDS) {
            issue(ctx, 'V-DERIVE', fp, `more than ${MAX_DERIVED_FIELDS} derived fields`);
            return null;
          }
          const k = checkExpr(ctx, expr, fp, 1);
          if (k !== null) ctx.derived.set(name, k);
        }
        break;
      }
      case 'sort': {
        if (typeof stage.by !== 'string' || (stage.dir !== 'asc' && stage.dir !== 'desc')) {
          issue(ctx, 'V-SHAPE', p, 'sort needs { by, dir: asc|desc }');
          break;
        }
        const k = resolveField(ctx, stage.by, p);
        if (k !== null && !SORTABLE_KINDS.includes(k)) {
          issue(ctx, 'V-TYPE', p, `cannot sort by ${k} field '${stage.by}'`);
        }
        break;
      }
      case 'limit': {
        if (!isInt(stage.n) || stage.n < 1 || stage.n > MAX_LIMIT) {
          issue(ctx, 'V-LIMIT', p, `limit.n must be 1..${MAX_LIMIT}`);
          break;
        }
        state.limitMin = state.limitMin === null ? stage.n : Math.min(state.limitMin, stage.n);
        break;
      }
      case 'aggregate': {
        if (ctx.grouped) { issue(ctx, 'V-GROUP', p, 'use groupBy aggs, not aggregate, after groupBy'); return null; }
        if (!final) { issue(ctx, 'V-PIPE', p, 'aggregate must be the final stage'); return null; }
        const names = checkAggs(ctx, stage.aggs, `${p}.aggs`);
        if (names === null) return null;
        ctx.aggregated = true;
        state.lastAggCount = names.size;
        ctx.grouped = names; // agg-name namespace for output.columns resolution
        break;
      }
      case 'groupBy': {
        if (ctx.grouped) { issue(ctx, 'V-GROUP', p, 'only one groupBy per pipeline (v1)'); return null; }
        const keys = typeof stage.key === 'string' ? [stage.key]
          : Array.isArray(stage.key) && stage.key.every((k) => typeof k === 'string') ? stage.key as string[]
          : null;
        if (!keys || keys.length === 0) { issue(ctx, 'V-SHAPE', p, 'groupBy.key must be a field or field list'); return null; }
        const groupedEnv = new Map<string, FieldKind>();
        for (const key of keys) {
          const k = resolveField(ctx, key, p);
          if (k === null) return null;
          if (k === 'enumSet') {
            issue(ctx, 'V-GROUP', p, `cannot group by multi-valued '${key}' — use share/has instead`);
            return null;
          }
          groupedEnv.set(key, k);
        }
        const names = checkAggs(ctx, stage.aggs, `${p}.aggs`);
        if (names === null) return null;
        for (const [name, kind] of names) {
          if (groupedEnv.has(name)) { issue(ctx, 'V-SHAPE', `${p}.aggs.${name}`, `'${name}' collides with a group key`); return null; }
          groupedEnv.set(name, kind);
        }
        ctx.grouped = groupedEnv;
        break;
      }
      case 'timeScan': {
        if (!final) { issue(ctx, 'V-SCAN', p, 'timeScan must be the final stage'); return null; }
        if (ctx.grouped) { issue(ctx, 'V-SCAN', p, 'timeScan does not apply to grouped relations'); return null; }
        if (ctx.universe !== 'live') { issue(ctx, 'V-SCAN', p, 'timeScan needs universe live'); return null; }
        const small = (state.pickCount !== null && state.pickCount <= TIMESCAN_MAX_OBJECTS)
          || (state.limitMin !== null && state.limitMin <= TIMESCAN_MAX_OBJECTS);
        if (!small) {
          issue(ctx, 'V-SCAN', p, `timeScan needs a prior pick/limit of ≤ ${TIMESCAN_MAX_OBJECTS} objects`);
          return null;
        }
        if (stage.direction !== 'forward' && stage.direction !== 'backward') {
          issue(ctx, 'V-SHAPE', p, 'timeScan.direction must be forward|backward'); return null;
        }
        if (!isInt(stage.stepMinutes) || stage.stepMinutes < 1) {
          issue(ctx, 'V-SCAN', p, 'timeScan.stepMinutes must be an int ≥ 1'); return null;
        }
        if (!isInt(stage.maxSteps) || stage.maxSteps < 1 || stage.maxSteps > MAX_TIMESCAN_STEPS) {
          issue(ctx, 'V-SCAN', p, `timeScan.maxSteps must be 1..${MAX_TIMESCAN_STEPS}`); return null;
        }
        const k = checkExpr(ctx, stage.predicate, `${p}.predicate`, 1);
        if (k !== null && k !== 'bool') issue(ctx, 'V-TYPE', `${p}.predicate`, 'timeScan.predicate must be bool');
        state.timeScanUsed = true;
        break;
      }
      default:
        issue(ctx, 'V-SHAPE', p, `unknown stage op '${stage.op}'`);
        return null;
    }
  }
  return state;
}

// ── Program validation ────────────────────────────────────────────────────────

export function validateProgram(input: unknown, opts?: { nowMs?: number }): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isRecord(input)) {
    return { ok: false, issues: [{ code: 'V-SHAPE', path: '$', message: 'program must be an object' }] };
  }
  if (input.v !== 1) {
    issues.push({ code: 'V-SHAPE', path: '$.v', message: 'v must be 1' });
  }
  const universe: Universe = input.universe === 'all' ? 'all' : 'live';
  if (input.universe !== 'live' && input.universe !== 'all') {
    issues.push({ code: 'V-SHAPE', path: '$.universe', message: `universe must be 'live' | 'all'` });
  }

  // timeBinding
  const tb = input.timeBinding;
  if (!isRecord(tb) || (tb.mode !== 'now' && tb.mode !== 'at')) {
    issues.push({ code: 'V-SHAPE', path: '$.timeBinding', message: `timeBinding.mode must be 'now' | 'at'` });
  } else if (tb.mode === 'at') {
    const t = typeof tb.t === 'string' ? Date.parse(tb.t) : NaN;
    if (Number.isNaN(t)) {
      issues.push({ code: 'V-SHAPE', path: '$.timeBinding.t', message: 't must be an ISO-8601 timestamp' });
    } else {
      const nowMs = opts?.nowMs ?? Date.now();
      if (t < nowMs - PAST_CAP_DAYS * MS_PER_DAY || t > nowMs + FUTURE_CAP_DAYS * MS_PER_DAY) {
        issues.push({
          code: 'V-TIMECAP', path: '$.timeBinding.t',
          message: `t outside the propagation window (−${PAST_CAP_DAYS} d … +${FUTURE_CAP_DAYS} d)`,
        });
      }
    }
  }

  if (typeof input.interpretation !== 'string' || input.interpretation.trim() === '') {
    issues.push({ code: 'V-INTERP', path: '$.interpretation', message: 'interpretation is mandatory' });
  }

  // Main pipeline
  const ctx: Ctx = { universe, issues, derived: new Map(), grouped: null, aggregated: false };
  const state = checkPipeline(ctx, input.pipeline, '$.pipeline');

  // compare pipeline (fresh relation state, same universe/time)
  if (input.compare !== undefined) {
    if (!isRecord(input.compare) || typeof input.compare.label !== 'string' || input.compare.label.trim() === '') {
      issues.push({ code: 'V-SHAPE', path: '$.compare', message: 'compare needs a non-empty label and a pipeline' });
    } else {
      const cmpCtx: Ctx = { universe, issues, derived: new Map(), grouped: null, aggregated: false };
      checkPipeline(cmpCtx, input.compare.pipeline, '$.compare.pipeline');
    }
  }

  // Output
  const out = input.output;
  if (!isRecord(out) || typeof out.shape !== 'string') {
    issues.push({ code: 'V-SHAPE', path: '$.output', message: 'output.shape is required' });
  } else if (state !== null) {
    const shape = out.shape;
    const grouped = ctx.grouped !== null && !ctx.aggregated;
    switch (shape) {
      case 'grouped':
        if (!grouped) issues.push({ code: 'V-OUTPUT', path: '$.output', message: `'grouped' output needs a groupBy pipeline` });
        break;
      case 'scalar':
        if (!((ctx.aggregated && state.lastAggCount === 1) || state.timeScanUsed)) {
          issues.push({ code: 'V-OUTPUT', path: '$.output', message: `'scalar' output needs a single-aggregate or timeScan pipeline` });
        }
        break;
      case 'object':
        if (grouped || ctx.aggregated || !(state.pickCount === 1 || state.limitMin === 1)) {
          issues.push({ code: 'V-OUTPUT', path: '$.output', message: `'object' output needs an ungrouped pipeline narrowed to one row (pick 1 id or limit 1)` });
        }
        break;
      case 'table':
        if (grouped || ctx.aggregated) {
          issues.push({ code: 'V-OUTPUT', path: '$.output', message: `use 'grouped'/'scalar' for grouped or aggregated pipelines` });
        } else if (state.limitMin === null) {
          issues.push({ code: 'V-LIMIT', path: '$.output', message: `'table' output requires a limit stage (use 'ids' for unbounded sets)` });
        }
        break;
      case 'ids':
        if (grouped || ctx.aggregated || state.timeScanUsed) {
          issues.push({ code: 'V-OUTPUT', path: '$.output', message: `'ids' output needs a plain object-set pipeline` });
        }
        break;
      default:
        issues.push({ code: 'V-SHAPE', path: '$.output.shape', message: `unknown output shape '${shape}'` });
    }
    if (out.columns !== undefined) {
      if (shape === 'scalar' || shape === 'ids') {
        issues.push({ code: 'V-OUTPUT', path: '$.output.columns', message: `columns do not apply to '${shape}' output` });
      } else if (!Array.isArray(out.columns) || !out.columns.every((c) => typeof c === 'string')) {
        issues.push({ code: 'V-SHAPE', path: '$.output.columns', message: 'columns must be a string array' });
      } else {
        for (const c of out.columns) resolveField(ctx, c, '$.output.columns');
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, program: input as unknown as AnalyticProgram };
}
