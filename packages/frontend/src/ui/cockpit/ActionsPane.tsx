import { useStore } from '../../store/useStore';
import { ActionRow } from './ActionRow';
import { GlassPane } from './GlassPane';
import { PaneHeader } from './PaneHeader';

/**
 * ACTIONS card. APPROACH [G] flies to and follows the lock (FOLLOWING · ON while
 * tracking), JOYRIDE [J], ORBIT TRAIL (click only, no key), CLEAR drops the
 * lock and flies home. Calls go through the store's trigger slots; ui/ never
 * imports the engine.
 */
export function ActionsPane({ delay }: { delay: number }) {
  const selectedIndex = useStore((s) => s.selectedIndex);
  const cameraMode = useStore((s) => s.cameraMode);
  const showOrbitTrail = useStore((s) => s.showOrbitTrail);
  const tracking = cameraMode === 'flying' || cameraMode === 'following';
  const noLock = selectedIndex === null;

  return (
    <GlassPane fromLeft={false} delay={delay}>
      <PaneHeader label="ACTIONS" />
      <div style={{ padding: '4px 12px 8px' }}>
        <ActionRow
          label={tracking ? 'FOLLOWING' : 'APPROACH'}
          hint={tracking ? 'ON' : '[G]'}
          active={tracking}
          disabled={noLock}
          onClick={() => selectedIndex !== null && useStore.getState().triggerFlyTo?.(selectedIndex)}
        />
        <ActionRow
          label="JOYRIDE"
          hint="[J]"
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
      </div>
    </GlassPane>
  );
}
