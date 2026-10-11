import { useStore } from '../../store/useStore';
import { dockMode } from './dock-modes';
import { DockSeg } from './DockSeg';
import { DOCK_GROUP, DOCK_LABEL } from './dockStyles';

/**
 * Dock left: MODE ORBIT · GROUND · JOYRIDE (where the camera is). ORBIT also
 * leaves a running joyride: the camera eases back out (cameraMode 'returning',
 * the lock is kept). GROUND needs a location; JOYRIDE needs a lock.
 */
export function ModeControls() {
  const vantage = useStore((s) => s.vantage);
  const hasObserver = useStore((s) => s.observerLocation !== null);
  const cameraMode = useStore((s) => s.cameraMode);
  const trackingStyle = useStore((s) => s.trackingStyle);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const canJoyride = useStore((s) => s.selectedIndex !== null && s.triggerJoyride !== null);
  const mode = dockMode(cameraMode, trackingStyle, vantage);

  const toOrbit = () => {
    const s = useStore.getState();
    if (mode === 'joyride') s.setCameraMode('returning');
    s.setVantage('orbit');
  };

  return (
    <div style={DOCK_GROUP}>
      <span style={DOCK_LABEL}>MODE</span>
      <DockSeg label="ORBIT" active={mode === 'orbit'} onClick={toOrbit} />
      <DockSeg
        label="GROUND"
        active={mode === 'ground'}
        disabled={!hasObserver}
        title={hasObserver ? undefined : 'Set a location first'}
        onClick={() => useStore.getState().setVantage('ground')}
      />
      <DockSeg
        label="JOYRIDE"
        active={mode === 'joyride'}
        disabled={!canJoyride}
        title={canJoyride ? undefined : 'Lock an object first'}
        onClick={() => selectedIndex !== null && useStore.getState().triggerJoyride?.(selectedIndex)}
      />
    </div>
  );
}
