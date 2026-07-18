// ============================================================
// useAnalyticAsk (P2/S7 — my_plans/marvin/perceptor_p2_plan.md).
//
// The one orchestration path from a typed question to an answer:
//   compile (backend NL→IR, client re-validated) → runAnalytic (engine command,
//   live executor) → answer slice + globe allow-set.
// Numbers only ever come from the executor; every failure lands in the answer
// slice as an honest, friendly message — never a silent no-op.
// ============================================================

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { compileQuestion, type CompileResult } from '../data/analytic-client';

function compileErrorMessage(r: Extract<CompileResult, { ok: false }>): string {
  switch (r.kind) {
    case 'refused':
      return r.reason;
    case 'unavailable':
      return 'Ask needs the backend AI key configured.';
    case 'ratelimited':
      return 'Too many questions — wait a minute.';
    case 'network':
      return 'Could not reach the server — check your connection.';
    case 'invalid':
      return r.message;
  }
}

function runtimeErrorMessage(code: string, message: string): string {
  if (code === 'E-OBSERVER') return 'Set your location first (📍 in the filter panel).';
  return message;
}

/**
 * Returns `ask(question)`. Fire-and-forget from the caller's perspective; the
 * result (or error) lands in the store's `analyticAnswer` slice, and an `ids`
 * answer also becomes the globe allow-set. A new ask aborts the in-flight one.
 */
export function useAnalyticAsk(): (question: string) => void {
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight compile on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return useCallback((question: string) => {
    const store = useStore.getState();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    store.setAnalyticAnswer({ status: 'compiling', question });

    void compileQuestion(question, controller.signal).then((compiled) => {
      if (controller.signal.aborted) return; // superseded by a newer ask
      // Re-read: the slice may have been cleared/replaced while compiling.
      const s = useStore.getState();

      if (!compiled.ok) {
        s.setAnalyticAnswer({ status: 'error', question, message: compileErrorMessage(compiled) });
        return;
      }

      const outcome = s.triggerRunAnalytic?.(compiled.program) ?? null;
      if (outcome === null) {
        s.setAnalyticAnswer({ status: 'error', question, message: 'The globe is still loading — try again in a moment.' });
        return;
      }
      if (!outcome.ok) {
        s.setAnalyticAnswer({
          status: 'error',
          question,
          message: runtimeErrorMessage(outcome.error.code, outcome.error.message),
        });
        return;
      }

      const result = outcome.result;
      if (result.shape === 'ids' && result.ids) {
        s.setAnalyticFilter(new Set(result.ids));
      } else {
        // A scalar/table answer must not leave a stale highlight standing.
        s.setAnalyticFilter(null);
      }
      s.setAnalyticAnswer({
        status: 'ready',
        question,
        interpretation: compiled.interpretation,
        result,
      });
    });
  }, []);
}
