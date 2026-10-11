import { useStore } from '../../store/useStore';
import { gearSpeedStr } from './format';
import { GEAR_READOUT_BELOW_CENTRE, GEAR_READOUT_RIGHT } from './layout';
import { useGearBump } from './useGearBump';

/**
 * Number half of the speed gauge, under the right rib: free-flight camera speed
 * (15 px, tabular) and "KM/S · G6/10". Glows once on a shift (remount on bump
 * restarts hud-gear-glow 620 ms). Dims to .4 outside free flight, where the
 * gear does nothing.
 */
export function GearReadout() {
  const gear = useStore((s) => s.cameraGear);
  const gearCount = useStore((s) => s.cameraGearCount);
  const speedMps = useStore((s) => s.cameraSpeedMps);
  const dim = useStore((s) => s.cameraMode !== 'free');
  const bump = useGearBump(gear);
  if (gearCount <= 1) return null;

  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        right: GEAR_READOUT_RIGHT,
        top: `calc(50% + ${GEAR_READOUT_BELOW_CENTRE}px)`,
        textAlign: 'right',
        whiteSpace: 'nowrap',
        lineHeight: 1.15,
        fontFamily: 'var(--font-hud-mono)',
        opacity: dim ? 0.4 : 1,
        transition: 'opacity 240ms ease',
      }}
    >
      <div
        key={`v${bump}`}
        className="hud-gear-value"
        style={{
          fontSize: 15,
          color: 'var(--hud-text)',
          fontVariantNumeric: 'tabular-nums',
          animation: bump > 0 ? 'hud-gear-glow 620ms cubic-bezier(0.2,0.8,0.2,1)' : 'none',
        }}
      >
        {gearSpeedStr(speedMps)}
      </div>
      <div style={{ fontSize: 8, letterSpacing: '0.14em', color: 'var(--hud-text-dim)', marginTop: 1 }}>
        KM/S · G{gear + 1}/{gearCount}
      </div>
    </div>
  );
}
