import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../../../store/useStore';
import { stepUtcField, type TimeField } from '../../../time/time-fields';

/** Quiet time before a stepped draft is committed with reviewAt, ms. */
export const STEP_COMMIT_MS = 220;

/**
 * Mouse time stepping (digit wheel, ▲▼ buttons). Steps accumulate in a ref
 * rather than re-reading simTimeMs, so a fast run of steps does not restart from
 * a stale value. Each step previews at once (cheap sky move); one trailing
 * reviewAt fires after STEP_COMMIT_MS of quiet, so 20 notches cause one reseed.
 */
export function useTimeStep(): (field: TimeField, dir: number) => void {
  const draft = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return useCallback((field, dir) => {
    const s = useStore.getState();
    const next = stepUtcField(draft.current ?? s.simTimeMs, field, dir);
    draft.current = next;
    s.scrubPreview(new Date(next));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      draft.current = null;
      useStore.getState().reviewAt(new Date(next));
    }, STEP_COMMIT_MS);
  }, []);
}
