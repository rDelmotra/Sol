// ============================================================
// Analytic compile route (P2/S3 — my_plans/marvin/perceptor_p2_plan.md).
//
// POST /api/query/compile { question } → a validated Analytic IR program, a
// first-class refusal, or an error. The compiler (cache + LLM seam) is built
// ONCE at module init so its cache lives for the process lifetime.
//
// The guard + outcome→HTTP mapping are pure helpers so they can be unit-tested
// without a network round-trip.
// ============================================================

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createAnalyticCompiler, type CompileOutcome } from '../services/analytic-compiler.js';
import { logger } from '../utils/logger.js';

// Built once — the compile cache is per-process.
const compiler = createAnalyticCompiler();

// ── Pure helpers ──────────────────────────────────────────────────────────────

export type QuestionCheck = { ok: true; question: string } | { ok: false; error: string };

export function validateQuestion(raw: unknown): QuestionCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'question must be a string' };
  const question = raw.trim();
  if (question.length < 3 || question.length > 300) {
    return { ok: false, error: 'question must be 3–300 characters after trimming' };
  }
  return { ok: true, question };
}

/** Map a CompileOutcome to an HTTP status + JSON body. A refusal is a 200
 *  (a successful answer of "no"); an unrepairable program is a 422; a compiler
 *  with no model is a 503. */
export function outcomeToHttp(outcome: CompileOutcome): { status: number; body: unknown } {
  if (outcome.ok) {
    return {
      status: 200,
      body: { ok: true, program: outcome.program, interpretation: outcome.interpretation, cached: outcome.cached },
    };
  }
  switch (outcome.kind) {
    case 'refused':
      return {
        status: 200,
        body: { ok: false, refused: true, code: outcome.code, reason: outcome.reason, cached: outcome.cached },
      };
    case 'invalid':
      return { status: 422, body: { ok: false, issues: outcome.issues } };
    case 'unavailable':
      return { status: 503, body: { ok: false, error: 'Compiler unavailable (no model configured).' } };
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

// Dedicated limiter: every cache MISS is one (or two, on repair) Haiku calls —
// this is the only cost-bearing endpoint, so it's tighter than the app-wide 100/15min.
const compileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many compile requests. Try again in a minute.' },
});

const router = Router();

router.post('/compile', compileLimiter, async (req: Request, res: Response) => {
  const check = validateQuestion((req.body as { question?: unknown } | undefined)?.question);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }

  try {
    const outcome = await compiler.compile(check.question);
    const { status, body } = outcomeToHttp(outcome);
    res.status(status).json(body);
  } catch (err) {
    logger.error('POST /api/query/compile failed:', err);
    res.status(500).json({ ok: false, error: 'Internal error compiling question.' });
  }
});

export default router;
