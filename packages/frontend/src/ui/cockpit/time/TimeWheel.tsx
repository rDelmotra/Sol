import { useEffect, useRef } from 'react';
import { useStore } from '../../../store/useStore';
import {
  FLICK_THRESHOLD, FRICTION, STOP_VELOCITY, TICK_COUNT, TICK_MAJOR_EVERY, TICK_PERIOD, TICK_SPACING,
  WHEEL_NOTCH_PX, tickStripOffset, wheelAdvance,
} from './time-console';

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
  const field = useStore((s) => s.scrubField);
  const fieldRef = useRef(field);
  fieldRef.current = field;

  const stripRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const lastX = useRef(0);
  const lastT = useRef(0);
  const vel = useRef(0);
  const viewMs = useRef(0);
  const tickAcc = useRef(0);
  const inertiaRaf = useRef<number | null>(null);

  const applyTick = () => {
    if (stripRef.current) stripRef.current.style.transform = `translateX(${tickStripOffset(tickAcc.current)}px)`;
  };
  const applyDelta = (dx: number) => {
    viewMs.current = wheelAdvance(viewMs.current, fieldRef.current, dx);
    useStore.getState().scrubPreview(new Date(viewMs.current));
  };
  const stopInertia = () => {
    if (inertiaRaf.current !== null) {
      cancelAnimationFrame(inertiaRaf.current);
      inertiaRaf.current = null;
    }
  };
  const seedFromClock = () => {
    viewMs.current = useStore.getState().simTimeMs;
  };

  const startInertia = (v0: number) => {
    let v = v0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.max(now - last, 1);
      last = now;
      const dx = v * dt;
      tickAcc.current += dx;
      applyTick();
      applyDelta(dx);
      v *= Math.pow(FRICTION, dt / 16);
      if (Math.abs(v) < STOP_VELOCITY) {
        inertiaRaf.current = null;
        useStore.getState().reviewAt(new Date(viewMs.current));
        return;
      }
      inertiaRaf.current = requestAnimationFrame(step);
    };
    inertiaRaf.current = requestAnimationFrame(step);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    stopInertia();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    moved.current = false;
    lastX.current = e.clientX;
    lastT.current = performance.now();
    vel.current = 0;
    seedFromClock();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const t = performance.now();
    const dx = e.clientX - lastX.current;
    const dt = t - lastT.current;
    lastX.current = e.clientX;
    lastT.current = t;

    let justStarted = false;
    if (!moved.current) {
      if (Math.abs(dx) < 1) return;
      moved.current = true;
      justStarted = true;
    }
    tickAcc.current += dx;
    applyTick();
    if (dt > 0) vel.current = 0.7 * vel.current + 0.3 * (dx / dt);
    applyDelta(dx);
    if (justStarted && useStore.getState().simRate !== 0) useStore.getState().setSimRate(0);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!moved.current) return;
    if (Math.abs(vel.current) > FLICK_THRESHOLD) startInertia(vel.current);
    else useStore.getState().reviewAt(new Date(viewMs.current));
  };

  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    stopInertia();
    seedFromClock();
    const dx = e.deltaY < 0 ? WHEEL_NOTCH_PX : -WHEEL_NOTCH_PX;
    tickAcc.current += dx;
    applyTick();
    applyDelta(dx);
    useStore.getState().reviewAt(new Date(viewMs.current));
  };

  useEffect(() => stopInertia, []);

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
        height: 36,
        marginTop: 8,
        background: 'oklch(0.08 0.015 250 / 0.65)',
        border: '1px solid var(--hud-glass-edge)',
        borderRadius: 6,
        overflow: 'hidden',
        cursor: 'ew-resize',
        touchAction: 'none',
        userSelect: 'none',
        boxShadow: 'inset 0 1px 4px rgba(0,0,0,0.5)',
        maskImage: 'linear-gradient(to right, transparent, black 15%, black 85%, transparent)',
        WebkitMaskImage: 'linear-gradient(to right, transparent, black 15%, black 85%, transparent)',
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
