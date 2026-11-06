import { useStore } from '../../../store/useStore';
import { EmptyPane } from '../primitives/EmptyPane';
import { PaneStack } from '../primitives/PaneStack';
import { ActionsPane } from './ActionsPane';
import { EncountersPane } from './EncountersPane';
import { ObjectScanPane } from './ObjectScanPane';
import { ReplayEventsPane } from './ReplayEventsPane';
import { TelemetryPane } from './TelemetryPane';

/**
 * Right stack (E): OBJECT SCAN (orbit diagram), TELEMETRY, ENCOUNTERS, ACTIONS.
 * History replay: the day's EVENTS card replaces ENCOUNTERS + ACTIONS (the
 * encounter screen is a live 36 h forecast), and shows even with no lock.
 */
export function FocusPanes() {
  const open = useStore((s) => s.focusPanelOpen);
  const selected = useStore((s) => s.selectedSatellite);
  const replaying = useStore((s) => s.replayDay !== null);
  if (!open) return null;

  if (replaying) {
    return (
      <PaneStack side="right">
        {selected
          ? [<ObjectScanPane key="scan" selected={selected} />, <TelemetryPane key="telemetry" selected={selected} />, <ReplayEventsPane key="events" />]
          : [<ReplayEventsPane key="events" />]}
      </PaneStack>
    );
  }

  return (
    <PaneStack side="right">
      {selected
        ? [<ObjectScanPane key="scan" selected={selected} />, <TelemetryPane key="telemetry" selected={selected} />, <EncountersPane key="encounters" selected={selected} />, <ActionsPane key="actions" />]
        : [<EmptyPane key="empty" text="NO OBJECT LOCKED" />]}
    </PaneStack>
  );
}
