import { useStore } from '../../../store/useStore';
import { EmptyPane } from '../primitives/EmptyPane';
import { PaneStack } from '../primitives/PaneStack';
import { ActionsPane } from './ActionsPane';
import { ObjectScanPane } from './ObjectScanPane';
import { TelemetryPane } from './TelemetryPane';

/** Right stack (E): OBJECT SCAN (orbit diagram + scan sweep), TELEMETRY, ACTIONS. */
export function FocusPanes() {
  const open = useStore((s) => s.focusPanelOpen);
  const selected = useStore((s) => s.selectedSatellite);
  if (!open) return null;

  return (
    <PaneStack side="right">
      {selected
        ? [<ObjectScanPane key="scan" selected={selected} />, <TelemetryPane key="telemetry" selected={selected} />, <ActionsPane key="actions" />]
        : [<EmptyPane key="empty" text="NO OBJECT LOCKED" />]}
    </PaneStack>
  );
}
