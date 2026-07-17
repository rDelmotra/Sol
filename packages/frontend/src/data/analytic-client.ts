// ============================================================
// analytic-client.ts — POST a question to the NL→IR compile endpoint.
//
// The backend already validated the program, but the browser executor is the
// final authority: we RE-VALIDATE the returned program client-side with the
// same @orbitwatch/analytic validator before trusting it. A server-said-ok but
// client-invalid program means version skew (client older than server) — we
// surface that as 'invalid' with a refresh hint rather than executing garbage.
// ============================================================

import { validateProgram, type AnalyticProgram } from '@orbitwatch/analytic';

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
