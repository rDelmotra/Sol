import { useEffect, useMemo } from 'react';
import { useStore } from '../../../store/useStore';
import { createTimeStepper } from './time-stepper';
import type { TimeField } from '../../../time/time-fields';

/**
 * Mouse time stepping (digit wheel, ▲▼ buttons): the debounce logic lives in
 * time-stepper.ts (pure, tested); this binds it to the store and cleans up on unmount.
 */
export function useTimeStep(): (field: TimeField, dir: number) => void {
  const stepper = useMemo(
    () =>
      createTimeStepper({
        simTimeMs: () => useStore.getState().simTimeMs,
        preview: (d) => useStore.getState().scrubPreview(d),
        commit: (d) => useStore.getState().reviewAt(d),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      }),
    [],
  );
  useEffect(() => stepper.cancel, [stepper]);
  return stepper.step;
}
