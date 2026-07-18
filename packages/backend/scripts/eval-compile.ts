// ============================================================
// P2/S9 — corpus eval harness (my_plans/marvin/perceptor_p2_plan.md).
//
// Runs every corpus question through the REAL compiler (live LLM key required)
// and scores against the exit criterion:
//   - >= 90% of non-expectRefusal questions produce VALID programs
//   - 100% of expectRefusal questions refuse
//   - zero INVALID after repair
// Writes data/eval-compile-report.json. Run from packages/backend:
//   npx tsx scripts/eval-compile.ts
// ============================================================

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createAnalyticCompiler } from '../src/services/analytic-compiler.js';
import { getPromptVersion } from '../src/services/analytic-prompt.js';

interface CorpusQuestion {
  id: string;
  class: string;
  question: string;
  expectRefusal: boolean;
  /** True where an honest refusal is a defensible alternate to compiling (v1 gaps). */
  refusalAcceptable?: boolean;
  note?: string;
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

// Fresh compiler, no persisted cache — every run is a true measurement.
const compiler = createAnalyticCompiler({ persist: false });

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
  console.log(`${row.outcome.padEnd(11)} ${row.pass ? 'pass' : 'FAIL'}  ${row.code ?? ''}`);
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

console.log('\n── exit criterion ──');
console.log(`answerable VALID rate: ${(validRate * 100).toFixed(1)}%  (need >= 90%)`);
console.log(`must-refuse REFUSED rate: ${(refuseRate * 100).toFixed(1)}%  (need 100%)`);
console.log(`INVALID after repair: ${invalidCount}  (need 0)`);
const met = validRate >= 0.9 && refuseRate === 1 && invalidCount === 0;
console.log(met ? '\n✓ EXIT CRITERION MET' : '\n✗ exit criterion NOT met');

const report = {
  ranAt: new Date().toISOString(),
  promptVersion: getPromptVersion(),
  model: process.env.ANALYTIC_COMPILER_MODEL || (process.env.GEMINI_API_KEY ? 'gemini-3.1-flash-lite' : 'claude-haiku-4-5'),
  validRate, refuseRate, invalidCount, met, byClass, rows,
};
if (!onlyIds) {
  const outPath = path.resolve(here, '../data/eval-compile-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`report → ${outPath}`);
}
