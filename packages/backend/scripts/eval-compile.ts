// ============================================================
// P2/S9 + P3/S7 — corpus eval harness (my_plans/marvin/perceptor_p2_plan.md,
// my_plans/marvin/p3/S7_eval_v2.md).
//
// Runs every corpus question through the REAL compiler (live LLM key required)
// and scores against the exit criterion:
//   - >= 90% of non-expectRefusal questions produce VALID programs
//   - 100% of expectRefusal questions refuse
//   - zero INVALID after repair
// S7 adds a v2 pass: every VALID program is EXECUTED against the real server
// registry (a strict superset of the client chain), catching programs that
// are schema-valid but return 0-basis hollow garbage at runtime (the "elon
// musk failed satellites" class — compile-time validity says nothing about
// whether the answer is actually meaningful).
// Writes data/eval-compile-report.json. Run from packages/backend:
//   npx tsx scripts/eval-compile.ts [--only A1,B2] [--no-exec]
// ============================================================

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { execute, programNeedsServer, type AnalyticProgram, type ResolvedObserver } from '@orbitwatch/analytic';
import { createAnalyticCompiler } from '../src/services/analytic-compiler.js';
import { getPromptVersion } from '../src/services/analytic-prompt.js';
import { getAnalyticRegistry } from '../src/analytic/index.js';
import { computeLowBasisFields, isHollow } from '../src/eval/hollow.js';

interface CorpusQuestion {
  id: string;
  class: string;
  question: string;
  expectRefusal: boolean;
  /** True where an honest refusal is a defensible alternate to compiling (v1 gaps). */
  refusalAcceptable?: boolean;
  note?: string;
  /** Explicit, reviewed acknowledgment that a field is expected to have a low
   *  measured basis for this question — see S7 Part D. */
  expectedLowBasis?: string[];
}

interface RuntimeRecord {
  routed: 'client' | 'server';
  execOk: boolean;
  error?: { code: string; message: string };
  matched?: number;
  scanned?: number;
  execMs: number;
  lowBasisFields: string[];
  hollow: boolean;
  slow: boolean;
}

interface EvalRow {
  id: string;
  class: string;
  question: string;
  expectRefusal: boolean;
  outcome: 'VALID' | 'REFUSED' | 'INVALID' | 'UNAVAILABLE' | 'ERROR';
  code?: string;          // refusal code or first V-code
  interpretation?: string;
  reason?: string;
  pass: boolean;
  tookMs?: number;
  runtime?: RuntimeRecord;
}

const here = path.dirname(fileURLToPath(import.meta.url));
let questions = JSON.parse(
  fs.readFileSync(path.join(here, 'corpus-questions.json'), 'utf8'),
) as CorpusQuestion[];

// Subset mode: `npx tsx scripts/eval-compile.ts --only A4,B2,B3` — iterate on
// failures without burning quota on the whole corpus. Subset runs do NOT
// overwrite the official report.
const onlyArg = process.argv.find((a) => a.startsWith('--only'));
const onlyIds = onlyArg ? (onlyArg.split('=')[1] ?? process.argv[process.argv.indexOf(onlyArg) + 1] ?? '').split(',').filter(Boolean) : null;
if (onlyIds && onlyIds.length > 0) {
  questions = questions.filter((q) => onlyIds.includes(q.id));
  console.log(`subset: ${questions.map((q) => q.id).join(', ')}`);
}

// `--no-exec`: compile-only, for prompt iteration — skips the S7 execution pass.
const noExec = process.argv.includes('--no-exec');

// Fresh compiler, no persisted cache — every run is a true measurement.
const compiler = createAnalyticCompiler({ persist: false });

// ── S7 execution pass setup ──────────────────────────────────────────────────
// One fixed instant + observer for the whole run (logged into the report, so a
// re-run is reproducible in intent even though the live catalog itself drifts).
const EVAL_TMS = Date.now();
const EVAL_OBSERVER: ResolvedObserver = { latDeg: 51.5, lonDeg: -0.12, altKm: 0 }; // London

const registry = getAnalyticRegistry();
const liveSource = noExec ? null : registry.buildSource('live');
const allSource = noExec ? undefined : (registry.buildSource('all') ?? undefined);
if (!noExec) {
  const liveSpineSize = registry.snapshot().universes.find((u) => u.universe === 'live')?.spineSize ?? 0;
  if (!liveSource || liveSpineSize <= 10_000) {
    console.error(
      `✗ registry precondition failed: live spine size ${liveSpineSize} (need > 10,000) — ` +
      `run the backend once to prime data/tle-cache.json, or pass --no-exec to skip execution.`,
    );
    process.exit(1);
  }
}

/** S7 Part B — execute a VALID program against the real server registry and
 *  build its runtime record. The eval always executes via the server chain
 *  (a strict superset of the client's fields) even for client-routed programs. */
function runProgram(program: AnalyticProgram, expectedLowBasis: string[]): RuntimeRecord {
  const routed: RuntimeRecord['routed'] = programNeedsServer(program) ? 'server' : 'client';
  const t0 = performance.now();
  const outcome = execute(program, { live: liveSource!, all: allSource }, { nowMs: EVAL_TMS, observer: EVAL_OBSERVER });
  const execMs = performance.now() - t0;

  if (!outcome.ok) {
    return { routed, execOk: false, error: outcome.error, execMs, lowBasisFields: [], hollow: false, slow: execMs > 3000 };
  }
  const { result } = outcome;
  const lowBasisFields = computeLowBasisFields(result.meta.coverage);
  return {
    routed, execOk: true, execMs,
    matched: result.meta.matched, scanned: result.meta.scanned,
    lowBasisFields,
    hollow: isHollow({
      matched: result.meta.matched,
      lowBasisFields,
      expectedLowBasis,
      isScalar: result.shape === 'scalar',
      scalarValue: result.value,
    }),
    slow: execMs > 3000,
  };
}

// Free-tier pacing (15 RPM): a question can cost TWO LLM calls (repair round),
// so 10s/question keeps worst case ~12 RPM. Retry 429s with backoff on top.
const THROTTLE_MS = 10_000;
const RETRY_BACKOFF_MS = 45_000;
const MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function compileWithRetry(question: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await compiler.compile(question);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') && attempt < MAX_RETRIES) {
        process.stdout.write(`(429, retry ${attempt + 1}) `);
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
}

const rows: EvalRow[] = [];
for (const q of questions) {
  process.stdout.write(`${q.id.padEnd(4)} `);
  let row: EvalRow;
  try {
    const r = await compileWithRetry(q.question);
    if (r.ok) {
      row = {
        ...q, outcome: 'VALID', interpretation: r.program.interpretation,
        pass: !q.expectRefusal, tookMs: r.tookMs,
      };
      if (!noExec) {
        row.runtime = runProgram(r.program, q.expectedLowBasis ?? []);
        // Runtime-error policy (S7 Part B): execOk===false is UNEXPECTED here
        // (observer supplied, sources asserted at startup) — fails the row
        // regardless of compile-time pass.
        if (!row.runtime.execOk) row.pass = false;
      }
    } else if (r.kind === 'refused') {
      row = {
        ...q, outcome: 'REFUSED', code: r.code, reason: r.reason,
        pass: q.expectRefusal || q.refusalAcceptable === true,
      };
    } else if (r.kind === 'invalid') {
      row = { ...q, outcome: 'INVALID', code: r.issues[0]?.code, reason: r.issues.map(i => `[${i.code}] ${i.path}: ${i.message}`).join(' | '), pass: false };
    } else {
      row = { ...q, outcome: 'UNAVAILABLE', pass: false };
    }
  } catch (err) {
    row = { ...q, outcome: 'ERROR', reason: err instanceof Error ? err.message : String(err), pass: false };
  }
  rows.push(row);
  const rt = row.runtime;
  const rtSummary = rt
    ? rt.execOk
      ? `  [${rt.routed} ${rt.execMs.toFixed(0)}ms matched=${rt.matched}${rt.hollow ? ' HOLLOW' : ''}${rt.slow ? ' SLOW' : ''}]`
      : `  [${rt.routed} RUNTIME-ERROR ${rt.error?.code}: ${rt.error?.message}]`
    : '';
  console.log(`${row.outcome.padEnd(11)} ${row.pass ? 'pass' : 'FAIL'}  ${row.code ?? ''}${rtSummary}`);
  await sleep(THROTTLE_MS);
}

// ── Scoring ───────────────────────────────────────────────────────────────────

const answerable = rows.filter((r) => !r.expectRefusal);
const mustRefuse = rows.filter((r) => r.expectRefusal);
// "Valid" for the exit criterion = the row passed (VALID, or an acceptable refusal).
const validRate = answerable.filter((r) => r.pass).length / answerable.length;
const refuseRate = mustRefuse.filter((r) => r.outcome === 'REFUSED').length / mustRefuse.length;
const invalidCount = rows.filter((r) => r.outcome === 'INVALID').length;

const byClass: Record<string, { total: number; valid: number; refused: number; invalid: number; failed: string[] }> = {};
for (const r of rows) {
  const c = (byClass[r.class] ??= { total: 0, valid: 0, refused: 0, invalid: 0, failed: [] });
  c.total += 1;
  if (r.outcome === 'VALID') c.valid += 1;
  if (r.outcome === 'REFUSED') c.refused += 1;
  if (r.outcome === 'INVALID') c.invalid += 1;
  if (!r.pass) c.failed.push(r.id);
}

console.log('\n── per-class ──');
for (const [cls, c] of Object.entries(byClass)) {
  console.log(
    `${cls}: ${c.valid} valid, ${c.refused} refused, ${c.invalid} invalid of ${c.total}` +
    (c.failed.length ? `  ✗ ${c.failed.join(',')}` : '  ✓'),
  );
}

// ── Runtime (v2) ─────────────────────────────────────────────────────────────

const runtimeRows = rows.filter((r): r is EvalRow & { runtime: RuntimeRecord } => r.runtime !== undefined);
const routedServer = runtimeRows.filter((r) => r.runtime.routed === 'server');
const routedClient = runtimeRows.filter((r) => r.runtime.routed === 'client');
const runtimeErrorRows = runtimeRows.filter((r) => !r.runtime.execOk);
const hollowRows = runtimeRows.filter((r) => r.runtime.execOk && r.runtime.hollow);
const slowIds = runtimeRows.filter((r) => r.runtime.execOk && r.runtime.slow).map((r) => r.id);
const runtimeErrors = runtimeErrorRows.length;
const hollowCount = hollowRows.length;

console.log('\n── exit criterion ──');
console.log(`answerable VALID rate: ${(validRate * 100).toFixed(1)}%  (need >= 90%)`);
console.log(`must-refuse REFUSED rate: ${(refuseRate * 100).toFixed(1)}%  (need 100%)`);
console.log(`INVALID after repair: ${invalidCount}  (need 0)`);

if (!noExec) {
  console.log('\n── runtime (v2) ──');
  console.log(`executed: ${runtimeRows.length} (server-routed: ${routedServer.length}, client-routed: ${routedClient.length})`);
  console.log(`runtime errors: ${runtimeErrors}            (need 0)` + (runtimeErrorRows.length ? `  ✗ ${runtimeErrorRows.map((r) => r.id).join(',')}` : ''));
  console.log(`hollow answers: ${hollowCount}            (need 0 — unacknowledged sub-5% basis)` + (hollowRows.length ? `  ✗ ${hollowRows.map((r) => r.id).join(',')}` : ''));
  console.log(`slow (>3s): ${slowIds.length ? slowIds.join(', ') : '(none)'}`);
  console.log(`client-routed ids: ${routedClient.map((r) => r.id).join(', ') || '(none)'}`);
}

const met = validRate >= 0.9 && refuseRate === 1 && invalidCount === 0
  && (noExec || (runtimeErrors === 0 && hollowCount === 0));
console.log(met ? '\n✓ EXIT CRITERION MET' : '\n✗ exit criterion NOT met');

const report = {
  ranAt: new Date().toISOString(),
  promptVersion: getPromptVersion(),
  model: process.env.ANALYTIC_COMPILER_MODEL || (process.env.GEMINI_API_KEY ? 'gemini-3.1-flash-lite' : 'claude-haiku-4-5'),
  validRate, refuseRate, invalidCount, met, byClass, rows,
  ...(noExec ? {} : {
    evalTMs: EVAL_TMS,
    observer: EVAL_OBSERVER,
    runtime: {
      executed: runtimeRows.length,
      routedServer: routedServer.length,
      routedClient: routedClient.length,
      runtimeErrors,
      hollowCount,
      slowIds,
    },
  }),
};
if (!onlyIds) {
  const outPath = path.resolve(here, '../data/eval-compile-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`report → ${outPath}`);
}
