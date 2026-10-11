import { keyHint } from '../../../bindings/bindings';
import { useStore } from '../../../store/useStore';
import { ActionRow } from '../primitives/ActionRow';
import { GlassPane } from '../primitives/GlassPane';
import { PaneBody } from '../primitives/PaneBody';
import { PaneHeader } from '../primitives/PaneHeader';
import type { PaneSlotProps } from '../primitives/PaneStack';

/**
 * ACTIONS card. APPROACH flies to and follows the lock (FOLLOWING · ON while
 * tracking), JOYRIDE, ORBIT TRAIL (click only, no key), CLEAR drops the
 * lock and flies home. Calls go through the store's trigger slots; ui/ never
 * imports the engine.
 */
export function ActionsPane({ delay = 0, fromLeft = false }: PaneSlotProps) {
  const selectedIndex = useStore((s) => s.selectedIndex);
  const cameraMode = useStore((s) => s.cameraMode);
  const showOrbitTrail = useStore((s) => s.showOrbitTrail);
  const tracking = cameraMode === 'flying' || cameraMode === 'following';
  const noLock = selectedIndex === null;

  return (
    <GlassPane fromLeft={fromLeft} delay={delay}>
      <PaneHeader label="ACTIONS" />
      <PaneBody padding="4px 12px 8px">
        <ActionRow
          label={tracking ? 'FOLLOWING' : 'APPROACH'}
          hint={tracking ? 'ON' : keyHint('flyTo')}
          active={tracking}
          disabled={noLock}
          onClick={() => selectedIndex !== null && useStore.getState().triggerFlyTo?.(selectedIndex)}
        />
        <ActionRow
          label="JOYRIDE"
          hint={keyHint('joyride')}
          disabled={noLock}
          onClick={() => selectedIndex !== null && useStore.getState().triggerJoyride?.(selectedIndex)}
        />
        <ActionRow
          label="ORBIT TRAIL"
          hint={showOrbitTrail ? 'ON' : 'OFF'}
          active={showOrbitTrail}
          onClick={() => useStore.getState().setShowOrbitTrail(!showOrbitTrail)}
        />
        <ActionRow
          label="CLEAR"
          hint="UNLOCK"
          onClick={() => {
            const s = useStore.getState();
            s.setSelectedSatellite(null, null);
            s.triggerResetCamera?.();
          }}
        />
      </PaneBody>
    </GlassPane>
  );
}
