import { useState } from 'react';
import { KEY_BINDINGS, PAD_BINDINGS } from '../../../bindings/bindings';
import { useStore } from '../../../store/useStore';
import { arcPath, ribAngle, ribDelayMs } from './arc';
import { GearReadout } from './GearReadout';
import { GearSweep } from './GearSweep';
import {
  ARC_BOX_H,
  ARC_BOX_W,
  ARC_GEOM,
  ARC_HIT_H,
  ARC_HIT_TOP,
  ARC_HIT_W,
  ARC_LABEL_INSET,
  ARC_R,
  ARC_SVG_W,
  RIB_COUNT,
  RIB_RIPPLE_MS,
  RIB_SPLAY_PX,
} from '../layout';

const SIDE = {
  left: { label: 'ANALYSIS', shortcut: KEY_BINDINGS.toggleAnalysis.caps[0], padGlyph: PAD_BINDINGS.dpadLeft.glyph },
  right: { label: 'FOCUS', shortcut: KEY_BINDINGS.toggleFocus.caps[0], padGlyph: PAD_BINDINGS.dpadRight.glyph },
} as const;

/**
 * Canopy rib on a screen edge: the way in to that side's panes. The click
 * target is an edge-flush 56×200 strip (cannot overshoot a screen edge), not
 * the curve. Hover, focus or open wakes it: stroke 1.1 → 1.5 → 1.8, nine ticks
 * splay 7 px rippling from the centre. Press nudges 2 px toward the edge.
 * Nothing moves on its own. The right rib carries the speed gauge.
 */
export function EdgeArc({ side }: { side: 'left' | 'right' }) {
  const open = useStore((s) => (side === 'left' ? s.analysisPanelOpen : s.focusPanelOpen));
  const gamepadConnected = useStore((s) => s.gamepadConnected);
  const [near, setNear] = useState(false);
  const [press, setPress] = useState(false);
  const { cx, cy, start, end } = ARC_GEOM[side];
  const { label, shortcut, padGlyph } = SIDE[side];
  const hasGauge = side === 'right';
  const awake = near || open;
  const glowId = `hud-arc-glow-${side}`;

  const onToggle = () => {
    const s = useStore.getState();
    if (side === 'left') s.toggleAnalysisPanel();
    else s.toggleFocusPanel();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <div
      className="hud-edge-arc"
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        [side]: 0,
        top: '50%',
        transform: 'translateY(-50%)',
        width: ARC_BOX_W,
        height: ARC_BOX_H,
      }}
    >
      <svg width={ARC_SVG_W} height={ARC_BOX_H} style={{ position: 'absolute', [side]: 0, top: 0, pointerEvents: 'none' }}>
        <defs>
          <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <path
          d={arcPath(cx, cy, ARC_R, start, end)}
          fill="none"
          stroke="var(--hud-arc)"
          strokeWidth={open ? 1.8 : near ? 1.5 : 1.1}
          opacity={awake ? 1 : 0.8}
          filter={`url(#${glowId})`}
          style={{ transition: 'stroke-width 180ms cubic-bezier(0.2,0.8,0.2,1), opacity 180ms ease' }}
        />

        {/* Each tick sits in a group rotated so its local +x points radially out on both sides. */}
        {Array.from({ length: RIB_COUNT }).map((_, i) => (
          <g key={i} transform={`rotate(${ribAngle(i, RIB_COUNT, start, end)}, ${cx}, ${cy})`}>
            <line
              className="hud-rib"
              x1={cx + ARC_R - 5}
              y1={cy}
              x2={cx + ARC_R + 5}
              y2={cy}
              stroke={awake ? 'var(--hud-arc)' : 'var(--hud-arc-dim)'}
              strokeWidth="0.9"
              strokeLinecap="round"
              style={{
                transform: awake ? `translateX(${RIB_SPLAY_PX}px)` : 'translateX(0px)',
                transitionDelay: `${ribDelayMs(i, RIB_COUNT, RIB_RIPPLE_MS)}ms`,
              }}
            />
          </g>
        ))}

        {hasGauge && <GearSweep />}
      </svg>

      {/* Vertical placard; reads top-to-bottom on both sides. */}
      <div
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          [side]: ARC_LABEL_INSET,
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 9,
          letterSpacing: '0.4em',
          writingMode: 'vertical-rl',
          fontFamily: 'var(--font-hud-mono)',
          whiteSpace: 'nowrap',
          color: awake ? 'var(--hud-text)' : 'var(--hud-text-dim)',
          transition: 'color 180ms ease',
        }}
      >
        {label} · {open ? 'OPEN' : gamepadConnected ? `${shortcut} ${padGlyph}` : shortcut}
      </div>

      {hasGauge && <GearReadout />}

      <div
        className="hud-edge-hit"
        role="button"
        tabIndex={0}
        aria-pressed={open}
        aria-label={`${label} panel`}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        onMouseEnter={() => setNear(true)}
        onMouseLeave={() => {
          setNear(false);
          setPress(false);
        }}
        onMouseDown={() => setPress(true)}
        onMouseUp={() => setPress(false)}
        onFocus={() => setNear(true)}
        onBlur={() => setNear(false)}
        style={{
          position: 'absolute',
          [side]: 0,
          top: ARC_HIT_TOP,
          width: ARC_HIT_W,
          height: ARC_HIT_H,
          pointerEvents: 'auto',
          cursor: 'pointer',
          transform: press ? `translateX(${side === 'left' ? -2 : 2}px)` : 'translateX(0)',
          transition: 'transform 90ms ease-out',
        }}
      />
    </div>
  );
}
