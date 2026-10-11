// ============================================================
// useAnalyticAsk (P2/S7, rewired P3/S5 — my_plans/marvin/p3/S5_client_switch.md).
//
// The one orchestration path from a typed question to an answer, now ONE
// round trip via /ask: compile (backend NL→IR, client re-validated) → the
// server decides client vs. server execution → answer slice + globe allow-set.
// `mode:'program'` keeps the client executor path (unchanged); `mode:'result'`
// lands the server's already-executed result directly. Numbers only ever come
// from an executor (client or server) — every failure lands in the answer
// slice as an honest, friendly message, never a silent no-op.
// ============================================================

import { useCallback, useEffect, useRef } from 'react';
import type { AnalyticResult } from '@orbitwatch/analytic';
import { useStore } from '../../store/useStore';
import { simClock } from '../../time/SimClock';
import { askQuestion, type AskResult } from '../../data/analytic-client';

function runtimeErrorMessage(code: string, message: string): string {
  if (code === 'E-OBSERVER') return 'Set your location first (📍 in the filter panel).';
  return message;
}

function askErrorMessage(r: Extract<AskResult, { ok: false }>): string {
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
    case 'runtime':
      if (r.code === 'E-UNIVERSE') return 'The catalog is still loading on the server — try again in a moment.';
      return runtimeErrorMessage(r.code, r.message);
  }
}

/** One exit door for both the client-executed and server-executed paths. */
function applyResult(
  s: ReturnType<typeof useStore.getState>,
  question: string,
  interpretation: string,
  result: AnalyticResult,
): void {
  if (result.shape === 'ids' && result.ids) {
    // No intersection with the live catalog on purpose: the renderer tests
    // allow-set membership per live-catalog object, so decayed noradIds from
    // a universe:'all' answer are naturally inert on the globe, while
    // AnswerCard's matched count stays the FULL server-side count. Don't
    // "fix" this into an intersection.
    s.setAnalyticFilter(new Set(result.ids));
  } else {
    // A scalar/table answer must not leave a stale highlight standing.
    s.setAnalyticFilter(null);
  }
  s.setAnalyticAnswer({ status: 'ready', question, interpretation, result });
}

/**
 * Returns `ask(question)`. Fire-and-forget from the caller's perspective; the
 * result (or error) lands in the store's `analyticAnswer` slice, and an `ids`
 * answer also becomes the globe allow-set. A new ask aborts the in-flight one.
 */
export function useAnalyticAsk(): (question: string) => void {
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight ask on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return useCallback((question: string) => {
    const store = useStore.getState();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    store.setAnalyticAnswer({ status: 'compiling', question });

    const observer = store.observerLocation
      ? { latDeg: store.observerLocation.lat, lonDeg: store.observerLocation.lon, altKm: store.observerLocation.alt }
      : null;

    void askQuestion({ question, tMs: simClock.now(), observer }, controller.signal).then((res) => {
      if (controller.signal.aborted) return; // superseded by a newer ask
      // Re-read: the slice may have been cleared/replaced while asking.
      const s = useStore.getState();

      if (!res.ok) {
        s.setAnalyticAnswer({ status: 'error', question, message: askErrorMessage(res) });
        return;
      }

      if (res.mode === 'result') {
        applyResult(s, question, res.interpretation, res.result);
        return;
      }

      // mode:'program' — the existing client fast path, unchanged.
      const outcome = s.triggerRunAnalytic?.(res.program) ?? null;
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
      applyResult(s, question, res.interpretation, outcome.result);
    });
  }, []);
}
