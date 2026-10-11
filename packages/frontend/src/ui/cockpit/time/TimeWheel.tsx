import { TIME_WHEEL_FADE_PCT, TIME_WHEEL_H } from '../layout';
import { TICK_COUNT, TICK_MAJOR_EVERY, TICK_PERIOD, TICK_SPACING } from './time-console';
import { useMomentumDial } from './useMomentumDial';

const WHEEL_FADE_MASK = `linear-gradient(to right, transparent, black ${TIME_WHEEL_FADE_PCT}%, black ${100 - TIME_WHEEL_FADE_PCT}%, transparent)`;

const ARROW: React.CSSProperties = {
  position: 'absolute', top: '50%', transform: 'translateY(-50%)', fontSize: 8,
  color: 'rgba(255,255,255,0.3)', pointerEvents: 'none',
};

/**
 * Horizontal momentum dial under the console clock. Drag right = later. The
 * first dragged pixel pauses the sim (simRate 0); release above FLICK_THRESHOLD
 * coasts, then commits with reviewAt. A scroll notch is 30 px and commits at once.
 * Every gesture (pointer-down, scroll) seeds from the live sim clock, so the dial
 * never starts from a stale or zero time.
 */
export function TimeWheel() {
  const { stripRef, onPointerDown, onPointerMove, onPointerUp, onWheel } = useMomentumDial();

  const ticks = [];
  for (let i = 0; i < TICK_COUNT; i++) {
    const major = i % TICK_MAJOR_EVERY === 0;
    ticks.push(
      <div
        key={i}
        style={{
          position: 'absolute',
          left: i * TICK_SPACING,
          top: '50%',
          transform: 'translateY(-50%)',
          width: major ? 2 : 1,
          height: major ? 16 : 8,
          background: `rgba(255,255,255,${major ? 0.6 : 0.22})`,
        }}
      />,
    );
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      title="Drag horizontally to scrub time with momentum"
      style={{
        pointerEvents: 'auto',
        position: 'relative',
        width: '100%',
        height: TIME_WHEEL_H,
        marginTop: 8,
        background: 'oklch(0.08 0.015 250 / 0.65)',
        border: '1px solid var(--hud-glass-edge)',
        borderRadius: 6,
        overflow: 'hidden',
        cursor: 'ew-resize',
        touchAction: 'none',
        userSelect: 'none',
        boxShadow: 'inset 0 1px 4px rgba(0,0,0,0.5)',
        maskImage: WHEEL_FADE_MASK,
        WebkitMaskImage: WHEEL_FADE_MASK,
      }}
    >
      <div style={{ ...ARROW, left: 6 }}>◀</div>
      <div style={{ ...ARROW, right: 6 }}>▶</div>
      <div ref={stripRef} style={{ position: 'absolute', inset: 0, left: -TICK_PERIOD }}>
        {ticks}
      </div>
      <div
        style={{
          position: 'absolute', left: '50%', top: 4, bottom: 4, width: 2, marginLeft: -1,
          background: 'var(--hud-warn)', boxShadow: '0 0 6px var(--hud-warn), 0 0 2px #fff',
        }}
      />
    </div>
  );
}
