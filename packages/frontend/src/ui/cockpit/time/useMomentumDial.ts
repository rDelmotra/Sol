import { useEffect, useRef } from 'react';
import { useStore } from '../../../store/useStore';
import {
  FLICK_THRESHOLD, FRICTION, STOP_VELOCITY, VELOCITY_KEEP, VELOCITY_NEW, WHEEL_NOTCH_PX,
  tickStripOffset, wheelAdvance,
} from './time-console';

/**
 * Gesture + inertia for the momentum dial (see TimeWheel for the behaviour).
 * Owns the drag state, the coasting rAF loop and its cleanup. The active field
 * is read from the store at the moment of each gesture, never captured in render.
 * Returns the strip ref (its translateX is written directly, no re-render) and
 * the four handlers to spread on the dial.
 */
export function useMomentumDial() {
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
    viewMs.current = wheelAdvance(viewMs.current, useStore.getState().scrubField, dx);
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
    if (dt > 0) vel.current = VELOCITY_KEEP * vel.current + VELOCITY_NEW * (dx / dt);
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

  return { stripRef, onPointerDown, onPointerMove, onPointerUp, onWheel };
}
