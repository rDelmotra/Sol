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

import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  PAST_CAP_DAYS, FUTURE_CAP_DAYS, programNeedsServer, execute, toWireResult,
  type ResolvedObserver,
} from '@orbitwatch/analytic';
import { createAnalyticCompiler, type AnalyticCompiler, type CompileOutcome } from '../services/analytic-compiler.js';
import { getAnalyticRegistry, type DataSourceRegistry } from '../analytic/index.js';
import { logger } from '../utils/logger.js';

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

const MS_PER_DAY = 86_400_000;

/** Non-finite/absent → nowMs. Otherwise clamp into the propagation window —
 *  honest because result.meta.evaluatedAt reports the instant actually used. */
export function resolveTMs(raw: unknown, nowMs: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return nowMs;
  const min = nowMs - PAST_CAP_DAYS * MS_PER_DAY;
  const max = nowMs + FUTURE_CAP_DAYS * MS_PER_DAY;
  return Math.min(Math.max(raw, min), max);
}

/** A malformed observer is never a 400 — it just means observer-needing
 *  programs hit E-OBSERVER, the honest runtime path. */
export function resolveObserver(raw: unknown): ResolvedObserver | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.latDeg !== 'number' || !Number.isFinite(o.latDeg) || o.latDeg < -90 || o.latDeg > 90) return null;
  if (typeof o.lonDeg !== 'number' || !Number.isFinite(o.lonDeg) || o.lonDeg < -180 || o.lonDeg > 180) return null;
  if (o.altKm !== undefined && (typeof o.altKm !== 'number' || !Number.isFinite(o.altKm) || o.altKm < 0)) return null;
  return { latDeg: o.latDeg, lonDeg: o.lonDeg, ...(o.altKm !== undefined ? { altKm: o.altKm } : {}) };
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

export interface QueryRouterDeps {
  /** Default: createAnalyticCompiler() (real LLM seam, per-process cache). */
  compiler?: AnalyticCompiler;
  /** Default: getAnalyticRegistry() (the S0–S3 catalog+enrichment+sgp4 registry). */
  registry?: DataSourceRegistry;
  /** Clock seam. Default: Date.now. */
  nowMs?: () => number;
}

export function createQueryRouter(deps: QueryRouterDeps = {}): Router {
  const compiler = deps.compiler ?? createAnalyticCompiler();
  const registry = deps.registry ?? getAnalyticRegistry();
  const nowMs = deps.nowMs ?? Date.now;

  // Dedicated limiter: every cache MISS is one (or two, on repair) Haiku calls —
  // this is the only cost-bearing endpoint pair, so it's tighter than the
  // app-wide 100/15min. Shared instance across /compile and /ask (one pool per IP).
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

  router.post('/ask', compileLimiter, async (req: Request, res: Response) => {
    const body = req.body as { question?: unknown; tMs?: unknown; observer?: unknown } | undefined;
    const check = validateQuestion(body?.question);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
    const tMs = resolveTMs(body?.tMs, nowMs());
    const observer = resolveObserver(body?.observer);

    try {
      const outcome = await compiler.compile(check.question);
      if (!outcome.ok) {
        const { status, body: httpBody } = outcomeToHttp(outcome);
        res.status(status).json(httpBody);
        return;
      }

      const program = outcome.program;
      if (!programNeedsServer(program)) {
        res.status(200).json({
          ok: true, mode: 'program', program,
          interpretation: outcome.interpretation, cached: outcome.cached,
        });
        return;
      }

      const live = registry.buildSource('live');
      const all = registry.buildSource('all');
      const source = program.universe === 'all' ? all : live;
      if (!source) {
        res.status(200).json({
          ok: false,
          runtime: { code: 'E-UNIVERSE', message: 'catalog still loading — try again shortly' },
        });
        return;
      }

      const execStart = nowMs();
      // execute() only dereferences `live` when program.universe is 'live' — the
      // `source` null-check above already covers that case, so this is safe even
      // when program.universe is 'all' and `live` itself is null.
      const execOutcome = execute(program, { live: live!, all: all ?? undefined }, { nowMs: tMs, observer });
      const execMs = nowMs() - execStart;

      const qHash = createHash('sha256').update(check.question).digest('hex').slice(0, 16);
      const logLine = `analytic ask [${qHash}] universe=${program.universe} ` +
        (execOutcome.ok
          ? `matched=${execOutcome.result.meta.matched} scanned=${execOutcome.result.meta.scanned} execMs=${execMs}`
          : `error=${execOutcome.error.code} execMs=${execMs}`);
      if (execMs > 3000) logger.warn(logLine);
      else logger.info(logLine);

      if (!execOutcome.ok) {
        res.status(200).json({ ok: false, runtime: execOutcome.error });
        return;
      }

      res.status(200).json({
        ok: true, mode: 'result', program,
        interpretation: outcome.interpretation, cached: outcome.cached,
        result: toWireResult(execOutcome.result),
      });
    } catch (err) {
      logger.error('POST /api/query/ask failed:', err);
      res.status(500).json({ ok: false, error: 'Internal error answering question.' });
    }
  });

  return router;
}

export default createQueryRouter();
