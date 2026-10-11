import { useStore } from '../../store/useStore';
import { arcPath, gearHue, gearSegmentAngles } from './arc';
import { ARC_GEOM, ARC_R, GEAR_SEG_GAP_DEG, GEAR_SWEEP_OFFSET } from './layout';
import { useGearBump } from './useGearBump';

/**
 * Speed gauge on the right rib: one segment per gear, filling bottom-up,
 * cyan → amber. Lit 3.2 wide / opacity 1, unlit 1.6 / .35, 220 ms. The segment
 * of a new gear flares once (hud-gear-flare 380 ms). Renders inside EdgeArc's svg.
 */
export function GearSweep() {
  const gear = useStore((s) => s.cameraGear);
  const gearCount = useStore((s) => s.cameraGearCount);
  const bump = useGearBump(gear);
  if (gearCount <= 1) return null;
  const { cx, cy, start, end } = ARC_GEOM.right;
  const r = ARC_R + GEAR_SWEEP_OFFSET;

  return (
    <g>
      {Array.from({ length: gearCount }).map((_, i) => {
        const [a1, a2] = gearSegmentAngles(i, gearCount, start, end, GEAR_SEG_GAP_DEG);
        const t = i / (gearCount - 1);
        const lit = i <= gear;
        const atGear = i === gear;
        return (
          <path
            key={i}
            className={atGear ? 'hud-gear-seg' : undefined}
            d={arcPath(cx, cy, r, a1, a2)}
            fill="none"
            stroke={lit ? gearHue(t) : 'var(--hud-arc-dim)'}
            strokeWidth={lit ? 3.2 : 1.6}
            strokeLinecap="round"
            opacity={lit ? 1 : 0.35}
            style={{
              transition: 'stroke 220ms ease, stroke-width 220ms ease, opacity 220ms ease',
              ...(atGear && bump > 0 ? { animation: 'hud-gear-flare 380ms cubic-bezier(0.2,0.8,0.2,1)' } : null),
            }}
          />
        );
      })}
    </g>
  );
}
