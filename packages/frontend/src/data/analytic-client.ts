// ============================================================
// analytic-client.ts — POST a question to the NL→IR compile endpoint.
//
// The backend already validated the program, but the browser executor is the
// final authority: we RE-VALIDATE the returned program client-side with the
// same @orbitwatch/analytic validator before trusting it. A server-said-ok but
// client-invalid program means version skew (client older than server) — we
// surface that as 'invalid' with a refresh hint rather than executing garbage.
// ============================================================

import { validateProgram, fromWireResult, type AnalyticProgram, type AnalyticResult, type AnalyticResultWire } from '@orbitwatch/analytic';

// Optional-chained so the module is importable under node:test (tsx), where
// Vite's import.meta.env injection is absent.
const API_BASE = import.meta.env?.VITE_API_URL ?? '';

export type CompileResult =
  | { ok: true; program: AnalyticProgram; interpretation: string; cached: boolean }
  | { ok: false; kind: 'refused'; code: string; reason: string }
  | { ok: false; kind: 'invalid' | 'unavailable' | 'network' | 'ratelimited'; message: string };

interface OkBody {
  ok: true;
  program: unknown;
  interpretation?: string;
  cached?: boolean;
}
interface RefusedBody {
  ok: false;
  refused: true;
  code: string;
  reason: string;
}
interface ErrorBody {
  ok?: false;
  error?: string;
  issues?: unknown[];
}

// P3 S4 — new callers should prefer askQuestion (one round trip, handles server
// execution); compileQuestion stays for the compile-only /compile consumers.
export async function compileQuestion(question: string, signal?: AbortSignal): Promise<CompileResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/query/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
      signal,
    });
  } catch (err) {
    return { ok: false, kind: 'network', message: err instanceof Error ? err.message : 'network error' };
  }

  if (res.status === 429) {
    return { ok: false, kind: 'ratelimited', message: 'Too many questions right now — give it a minute.' };
  }
  if (res.status === 503) {
    return { ok: false, kind: 'unavailable', message: 'The answer engine is not available right now.' };
  }

  let body: OkBody | RefusedBody | ErrorBody;
  try {
    body = (await res.json()) as OkBody | RefusedBody | ErrorBody;
  } catch {
    return { ok: false, kind: 'network', message: 'Malformed response from the server.' };
  }

  if (res.ok && (body as OkBody).ok === true) {
    const okBody = body as OkBody;
    const v = validateProgram(okBody.program);
    if (!v.ok) {
      return {
        ok: false,
        kind: 'invalid',
        message: 'The compiled answer failed local validation — please refresh (the app may be out of date).',
      };
    }
    return {
      ok: true,
      program: v.program,
      interpretation: okBody.interpretation ?? v.program.interpretation,
      cached: Boolean(okBody.cached),
    };
  }

  if (res.ok && (body as RefusedBody).refused) {
    const r = body as RefusedBody;
    return { ok: false, kind: 'refused', code: r.code, reason: r.reason };
  }

  // Non-ok (400 guard / 422 unrepairable / other) — treat as invalid with the
  // best available message.
  const errBody = body as ErrorBody;
  const message =
    errBody.error ??
    (Array.isArray(errBody.issues) ? 'The question could not be compiled into a valid query.' : 'Compilation failed.');
  return { ok: false, kind: 'invalid', message };
}

// ── askQuestion (P3 S4/S5) — one round trip: compile + server-side execute ────

export interface AskInput {
  question: string;
  tMs: number;
  observer: { latDeg: number; lonDeg: number; altKm?: number } | null;
}

export type AskResult =
  | { ok: true; mode: 'result'; program: AnalyticProgram; interpretation: string; result: AnalyticResult; cached: boolean }
  | { ok: true; mode: 'program'; program: AnalyticProgram; interpretation: string; cached: boolean }
  | { ok: false; kind: 'refused'; code: string; reason: string }
  | { ok: false; kind: 'runtime'; code: string; message: string }
  | { ok: false; kind: 'invalid' | 'unavailable' | 'network' | 'ratelimited'; message: string };

interface AskOkBody {
  ok: true;
  mode: 'program' | 'result';
  program: unknown;
  interpretation?: string;
  cached?: boolean;
  result?: AnalyticResultWire;
}
interface RuntimeErrorBody {
  ok: false;
  runtime: { code: string; message: string };
}

export async function askQuestion(input: AskInput, signal?: AbortSignal): Promise<AskResult> {
  let res: Response;
  try {
    const payload: Record<string, unknown> = { question: input.question, tMs: input.tMs };
    if (input.observer) payload.observer = input.observer; // never send observer: null
    res = await fetch(`${API_BASE}/api/query/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    return { ok: false, kind: 'network', message: err instanceof Error ? err.message : 'network error' };
  }

  if (res.status === 429) {
    return { ok: false, kind: 'ratelimited', message: 'Too many questions right now — give it a minute.' };
  }
  if (res.status === 503) {
    return { ok: false, kind: 'unavailable', message: 'The answer engine is not available right now.' };
  }

  let body: AskOkBody | RuntimeErrorBody | RefusedBody | ErrorBody;
  try {
    body = (await res.json()) as AskOkBody | RuntimeErrorBody | RefusedBody | ErrorBody;
  } catch {
    return { ok: false, kind: 'network', message: 'Malformed response from the server.' };
  }

  if (res.ok && (body as AskOkBody).ok === true) {
    const okBody = body as AskOkBody;
    // Client re-validation stays MANDATORY in both modes — the version-skew
    // guard. A server-said-ok program the client's validator rejects means
    // skew (client older than server); don't trust the ride-along result either.
    const v = validateProgram(okBody.program);
    if (!v.ok) {
      return {
        ok: false,
        kind: 'invalid',
        message: 'The compiled answer failed local validation — please refresh (the app may be out of date).',
      };
    }
    const interpretation = okBody.interpretation ?? v.program.interpretation;
    const cached = Boolean(okBody.cached);

    if (okBody.mode === 'result') {
      if (!okBody.result) {
        return { ok: false, kind: 'network', message: 'Malformed response from the server.' };
      }
      return { ok: true, mode: 'result', program: v.program, interpretation, cached, result: fromWireResult(okBody.result) };
    }
    return { ok: true, mode: 'program', program: v.program, interpretation, cached };
  }

  if (res.ok && (body as RuntimeErrorBody).runtime) {
    const r = body as RuntimeErrorBody;
    return { ok: false, kind: 'runtime', code: r.runtime.code, message: r.runtime.message };
  }

  if (res.ok && (body as RefusedBody).refused) {
    const r = body as RefusedBody;
    return { ok: false, kind: 'refused', code: r.code, reason: r.reason };
  }

  // Non-ok (400 guard / 422 unrepairable / other) — treat as invalid with the
  // best available message.
  const errBody = body as ErrorBody;
  const message =
    errBody.error ??
    (Array.isArray(errBody.issues) ? 'The question could not be compiled into a valid query.' : 'Compilation failed.');
  return { ok: false, kind: 'invalid', message };
}
