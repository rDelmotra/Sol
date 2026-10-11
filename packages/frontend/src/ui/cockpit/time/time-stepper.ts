import { stepUtcField, type TimeField } from '../../../time/time-fields';

/** Quiet time before a stepped draft is committed with reviewAt, ms. */
export const STEP_COMMIT_MS = 220;

/** What the stepper needs from the outside: the clock, the store calls and a timer. */
export interface StepperDeps {
  simTimeMs(): number;
  preview(d: Date): void;
  commit(d: Date): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Debounced field stepping as plain state. Steps accumulate in `draft` rather
 * than re-reading the sim clock, so a fast run of steps does not restart from a
 * stale value. Each step previews at once; one trailing commit fires after
 * STEP_COMMIT_MS of quiet. `cancel` drops a pending commit (unmount).
 */
export function createTimeStepper(deps: StepperDeps) {
  let draft: number | null = null;
  let timer: unknown = null;
  return {
    step(field: TimeField, dir: number): void {
      const next = stepUtcField(draft ?? deps.simTimeMs(), field, dir);
      draft = next;
      deps.preview(new Date(next));
      if (timer !== null) deps.clearTimeout(timer);
      timer = deps.setTimeout(() => {
        timer = null;
        draft = null;
        deps.commit(new Date(next));
      }, STEP_COMMIT_MS);
    },
    cancel(): void {
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    },
  };
}
