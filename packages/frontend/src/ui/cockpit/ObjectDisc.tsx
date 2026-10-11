import { useRef } from 'react';
import { isDomeView, useStore } from '../../store/useStore';
import { useElementSize } from './useElementSize';
import {
  PRIMARY_ANGLES,
  SECONDARY_ANGLES,
  SECTOR_HALF_DEG,
  TICK_COUNT,
  discItems,
  discRadius,
  polar,
  sectorPath,
  type DiscItem,
  type Pt,
} from './disc';

/**
 * The object disc: a ring of readouts around screen centre for the locked
 * object. Bright arcs on the right carry the primary facts; dim arcs on the
 * left carry the rest of the record. Hidden in ground (dome) view, where the
 * compass owns the screen. The ring and the labels are split so the labels
 * (live values, ~4 Hz) re-render without redrawing the 81 ring paths.
 */
export function ObjectDisc() {
  const ready = useStore((s) => s.loadingPhase === 'ready');
  const hasLock = useStore((s) => s.selectedSatellite !== null);
  const dome = useStore((s) => isDomeView(s));
  const boxRef = useRef<HTMLDivElement>(null);
  const { w, h } = useElementSize(boxRef);
  const show = ready && hasLock && !dome;

  return (
    <div ref={boxRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {show && w > 0 && (
        <>
          <DiscRing w={w} h={h} />
          <DiscLabels w={w} h={h} />
        </>
      )}
    </div>
  );
}

function DiscRing({ w, h }: { w: number; h: number }) {
  const C = { x: w / 2, y: h / 2 };
  const r = discRadius(w, h);
  return (
    <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }}>
      {[...PRIMARY_ANGLES, ...SECONDARY_ANGLES].map((a, i) => {
        const isPrimary = i < PRIMARY_ANGLES.length;
        return (
          <path
            key={a}
            d={sectorPath(C, r, a - SECTOR_HALF_DEG, a + SECTOR_HALF_DEG)}
            fill="none"
            stroke={isPrimary ? 'var(--hud-arc)' : 'var(--hud-arc-dim)'}
            strokeWidth={isPrimary ? 1.6 : 1}
            opacity={isPrimary ? 0.9 : 0.5}
          />
        );
      })}
      {Array.from({ length: TICK_COUNT }, (_, i) => {
        const a = i * 5;
        const p1 = polar(C, r - 4, a);
        const p2 = polar(C, r + (i % 6 === 0 ? 7 : 3), a);
        return (
          <line
            key={a}
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke="var(--hud-arc-dim)"
            strokeWidth={0.6}
            opacity={i % 6 === 0 ? 0.8 : 0.35}
          />
        );
      })}
    </svg>
  );
}

function DiscLabels({ w, h }: { w: number; h: number }) {
  const selected = useStore((s) => s.selectedSatellite);
  const liveAlt = useStore((s) => s.liveAltitudeKm);
  const liveVel = useStore((s) => s.liveSpeedKmS);
  if (!selected) return null;
  const C = { x: w / 2, y: h / 2 };
  const r = discRadius(w, h);
  const { primary, secondary } = discItems(selected, liveAlt, liveVel);
  return (
    <>
      {primary.map((it, i) => (
        <RingItem key={it.k} C={C} r={r} angle={PRIMARY_ANGLES[i]!} item={it} primary />
      ))}
      {secondary.map((it, i) => (
        <RingItem key={it.k} C={C} r={r} angle={SECONDARY_ANGLES[i]!} item={it} />
      ))}
    </>
  );
}

function RingItem({ C, r, angle, item, primary }: { C: Pt; r: number; angle: number; item: DiscItem; primary?: boolean }) {
  const p = polar(C, r + (primary ? 16 : 13), angle);
  const right = Math.sin((angle * Math.PI) / 180) >= 0;
  return (
    <div
      style={{
        position: 'absolute',
        left: p.x,
        top: p.y,
        transform: `translate(${right ? '0' : '-100%'}, -50%)`,
        textAlign: right ? 'left' : 'right',
        fontFamily: 'var(--font-hud-mono)',
        whiteSpace: 'nowrap',
      }}
    >
      <div style={{ fontSize: 8, letterSpacing: '0.22em', color: 'var(--hud-text-dim)' }}>{item.k}</div>
      <div
        style={{
          fontSize: primary ? 14 : 11,
          color: primary ? 'var(--hud-text)' : 'var(--hud-text-dim)',
          letterSpacing: '0.04em',
        }}
      >
        {item.v}
      </div>
    </div>
  );
}
