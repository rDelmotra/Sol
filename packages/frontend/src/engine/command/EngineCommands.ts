import { useStore } from '../../store/useStore';

/**
 * The Engine's imperative command surface — the actions UI (and, later, a voicebot)
 * trigger on the running engine. The Engine builds one of these from its
 * {@link NavigationController} + sim-time hook and registers it ONCE via
 * {@link registerEngineCommands}, which fans it out into the store's command slots
 * that `InfoCard` / `SearchBar` / `App` already read (the UI is unchanged).
 *
 * This consolidates the previously-scattered `setTrigger*` / `setSelectByIndex`
 * calls into a single typed surface: one place that defines "what you can ask the
 * engine to do."
 */
export interface EngineCommands {
  /** Select a TLE object by catalog index (no camera move). */
  selectByIndex: (index: number) => void;
  /** Fly the camera to + follow a TLE object. */
  flyTo: (index: number) => void;
  /** Joyride (first-person) a TLE object. */
  joyride: (index: number) => void;
  /** Return the camera home. */
  resetCamera: () => void;
  /** Fly the camera to + follow a DSO. */
  flyToDso: (dsoId: string) => void;
  /** Joyride a DSO. */
  joyrideDso: (dsoId: string) => void;
  /** Re-propagate immediately at the new sim time (store invokes on rate/jump/reset). */
  simTimeJump: () => void;
  /** Light scrub preview: day-aware throttled snap (store invokes during a wheel drag). */
  scrubPreview: () => void;
  /** Animate the view-clock smoothly back to the live present (store invokes from "Now"). */
  returnToPresent: () => void;
}

/** Register the command surface into the store's slots in one shot. */
export function registerEngineCommands(commands: EngineCommands): void {
  const store = useStore.getState();
  store.setSelectByIndex(commands.selectByIndex);
  store.setTriggerFlyTo(commands.flyTo);
  store.setTriggerJoyride(commands.joyride);
  store.setTriggerResetCamera(commands.resetCamera);
  store.setTriggerFlyToDso(commands.flyToDso);
  store.setTriggerJoyrideDso(commands.joyrideDso);
  store.setTriggerSimTimeJump(commands.simTimeJump);
  store.setTriggerScrubPreview(commands.scrubPreview);
  store.setTriggerReturnToPresent(commands.returnToPresent);
}
