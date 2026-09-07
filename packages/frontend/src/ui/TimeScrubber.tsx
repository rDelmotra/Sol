import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';

// ============================================================
// Time Scrubber — a Star Walk-style "time machine" (replaces the Pass-1 slider).
//
// The simulation clock (simClock) is the single source of truth; this component
// only MODIFIES it and everything else reacts:
//   - drag the wheel  → scrubPreview(date)   (moves the clock/sky continuously)
//   - release         → reviewAt(date)        (commits → Engine reseeds on settle)
//   - "Return"        → returnToPresent()      (Engine eases the clock home)
//
// A modal clock toggle opens a top-center field panel (Y/M/D/HH:MM) + a right-edge
// vertical thumbwheel with per-field sensitivity + flick inertia, and dims the rest
// of the HUD (the dimming is applied in App). The wheel scrubs CONTINUOUSLY (smooth
// sky); the active field only sets how many units one wheel rotation spans.
//
// Out of scope (per product decision): audio + haptic feedback.
// ============================================================

type Field = 'year' | 'month' | 'day' | 'hour' | 'minute';

const FIELD_ORDER: Field[] = ['year', 'month', 'day', 'hour', 'minute'];

// One full wheel rotation (PX_PER_ROTATION px of drag) spans this many units.
const WHEEL_SCALE: Record<Field, number> = { year: 100, month: 12, day: 30, hour: 24, minute: 60 };
const UNIT_MS: Record<Field, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  month: 2_592_000_000, // 30 d (sensitivity only; the clock moves continuously)
  year: 31_557_600_000, // 365.25 d
};
const PX_PER_ROTATION = 240;
const MS_PER_PX: Record<Field, number> = {
  year: (WHEEL_SCALE.year * UNIT_MS.year) / PX_PER_ROTATION,
  month: (WHEEL_SCALE.month * UNIT_MS.month) / PX_PER_ROTATION,
  day: (WHEEL_SCALE.day * UNIT_MS.day) / PX_PER_ROTATION,
  hour: (WHEEL_SCALE.hour * UNIT_MS.hour) / PX_PER_ROTATION,
  minute: (WHEEL_SCALE.minute * UNIT_MS.minute) / PX_PER_ROTATION,
};

// Wheel flick inertia.
const FLICK_THRESHOLD = 0.05; // px/ms — below this, a release just commits (no spin)
const FRICTION = 0.94; // velocity retained per ~16 ms frame
const STOP_VEL = 0.008; // px/ms — inertia ends here

// Tick strip geometry (cosmetic — the ticks scroll with the finger for tactile feel).
const TICK_SPACING = 12;
const TICK_MAJOR_EVERY = 5;
const TICK_PERIOD = TICK_SPACING * TICK_MAJOR_EVERY;
const WHEEL_HEIGHT = 300;
const WHEEL_WIDTH = 54;
const TICK_COUNT = Math.ceil((WHEEL_HEIGHT + 2 * TICK_PERIOD) / TICK_SPACING) + 1;

const ACCENT = '#63b3ed';

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/** Inject the pill-pulse keyframes once (avoids a <style> node re-rendering every frame). */
function ensurePulseKeyframes(): void {
  if (typeof document === 'undefined' || document.getElementById('ow-pill-pulse-kf')) return;
  const el = document.createElement('style');
  el.id = 'ow-pill-pulse-kf';
  el.textContent =
    '@keyframes ow-pill-pulse{0%,100%{box-shadow:0 0 0 0 rgba(99,179,237,0);}50%{box-shadow:0 0 0 5px rgba(99,179,237,0.22);}}';
  document.head.appendChild(el);
}

// ── Styling ──────────────────────────────────────────────────────────────────

const glass: React.CSSProperties = {
  background: 'rgba(8, 12, 20, 0.62)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  fontFamily: 'monospace',
  color: 'rgba(255, 255, 255, 0.85)',
  pointerEvents: 'auto',
};

const iconBtn: React.CSSProperties = {
  ...glass,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  borderRadius: 8,
  cursor: 'pointer',
  padding: 0,
};

// ── Icons ──────────────────────────────────────────────────────────────────

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

function ReturnIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 1 3 6.36" />
      <polyline points="3 22 3 16 9 16" />
    </svg>
  );
}

// ── Time display panel (top-center) ──────────────────────────────────────────

function TimePanel({
  simTimeMs,
  active,
  onSelect,
}: {
  simTimeMs: number;
  active: Field;
  onSelect: (f: Field) => void;
}) {
  const d = new Date(simTimeMs);
  const values: Record<Field, string> = {
    year: pad(d.getUTCFullYear(), 4),
    month: pad(d.getUTCMonth() + 1),
    day: pad(d.getUTCDate()),
    hour: pad(d.getUTCHours()),
    minute: pad(d.getUTCMinutes()),
  };

  const part = (f: Field) => (
    <span
      onClick={() => onSelect(f)}
      style={{
        cursor: 'pointer',
        padding: '1px 4px',
        borderRadius: 4,
        color: active === f ? '#fff' : 'rgba(255,255,255,0.65)',
        background: active === f ? 'rgba(99,179,237,0.22)' : 'transparent',
        borderBottom: `2px solid ${active === f ? ACCENT : 'transparent'}`,
        transition: 'color 0.15s, background 0.15s',
      }}
    >
      {values[f]}
    </span>
  );

  return (
    <div
      style={{
        ...glass,
        position: 'absolute',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '8px 14px',
        borderRadius: 10,
        fontSize: 18,
        letterSpacing: '0.04em',
        fontVariantNumeric: 'tabular-nums',
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        userSelect: 'none',
      }}
    >
      {part('year')}
      <span style={{ color: 'rgba(255,255,255,0.3)' }}>-</span>
      {part('month')}
      <span style={{ color: 'rgba(255,255,255,0.3)' }}>-</span>
      {part('day')}
      <span style={{ width: 8 }} />
      {part('hour')}
      <span style={{ color: 'rgba(255,255,255,0.3)' }}>:</span>
      {part('minute')}
      <span style={{ marginLeft: 8, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>UTC</span>
    </div>
  );
}

// ── Vertical thumbwheel (right edge) ─────────────────────────────────────────

function ThumbWheel({ activeRef }: { activeRef: React.MutableRefObject<Field> }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const lastY = useRef(0);
  const lastT = useRef(0);
  const vel = useRef(0); // px/ms, screen-down positive
  const viewMs = useRef(0);
  const tickOffset = useRef(0);
  const inertiaRaf = useRef<number | null>(null);

  const applyTickTransform = () => {
    if (!stripRef.current) return;
    const off = ((tickOffset.current % TICK_PERIOD) + TICK_PERIOD) % TICK_PERIOD;
    stripRef.current.style.transform = `translateY(${off}px)`;
  };

  // dyUp > 0 means the finger moved up → advance time forward.
  const applyTimeDelta = (dyUp: number) => {
    viewMs.current += dyUp * MS_PER_PX[activeRef.current];
    useStore.getState().scrubPreview(new Date(viewMs.current));
  };

  const stopInertia = () => {
    if (inertiaRaf.current !== null) {
      cancelAnimationFrame(inertiaRaf.current);
      inertiaRaf.current = null;
    }
  };

  const startInertia = (v0: number) => {
    let v = v0; // screen-down px/ms
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.max(now - last, 1);
      last = now;
      const dyDown = v * dt;
      tickOffset.current += dyDown;
      applyTickTransform();
      applyTimeDelta(-dyDown);
      v *= Math.pow(FRICTION, dt / 16);
      if (Math.abs(v) < STOP_VEL) {
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
    stopInertia();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    moved.current = false;
    lastY.current = e.clientY;
    lastT.current = performance.now();
    vel.current = 0;
    viewMs.current = useStore.getState().simTimeMs;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const y = e.clientY;
    const t = performance.now();
    const dyDown = y - lastY.current;
    const dt = t - lastT.current;
    lastY.current = y;
    lastT.current = t;

    let justStarted = false;
    if (!moved.current) {
      if (Math.abs(dyDown) < 1) return;
      moved.current = true;
      justStarted = true;
    }

    tickOffset.current += dyDown;
    applyTickTransform();
    if (dt > 0) vel.current = 0.7 * vel.current + 0.3 * (dyDown / dt);
    applyTimeDelta(-dyDown); // scrubPreview → marks the scrub active in the Engine

    // Park the clock where you drop it — AFTER the first preview, so the Engine's
    // reconcile already sees an active scrub and won't re-seed mid-drag.
    if (justStarted && useStore.getState().simRate !== 0) {
      useStore.getState().setSimRate(0);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (!moved.current) return; // a tap is not a scrub
    if (Math.abs(vel.current) > FLICK_THRESHOLD) startInertia(vel.current);
    else useStore.getState().reviewAt(new Date(viewMs.current));
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
          top: i * TICK_SPACING,
          right: 8,
          width: major ? 18 : 10,
          height: major ? 2 : 1,
          background: `rgba(255,255,255,${major ? 0.5 : 0.25})`,
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
      style={{
        ...glass,
        position: 'absolute',
        right: 8,
        top: '50%',
        transform: 'translateY(-50%)',
        width: WHEEL_WIDTH,
        height: WHEEL_HEIGHT,
        borderRadius: 12,
        overflow: 'hidden',
        cursor: 'ns-resize',
        touchAction: 'none',
        userSelect: 'none',
        // Cylindrical fade — ticks dissolve toward the top + bottom.
        maskImage: 'linear-gradient(to bottom, transparent, black 22%, black 78%, transparent)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 22%, black 78%, transparent)',
      }}
    >
      {/* Scrolling tick strip (positioned above the visible window, wrapped by period). */}
      <div ref={stripRef} style={{ position: 'absolute', inset: 0, top: -TICK_PERIOD }}>{ticks}</div>
      {/* Fixed center indicator line. */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: 6,
          right: 6,
          height: 2,
          marginTop: -1,
          background: 'rgba(255,255,255,0.75)',
          boxShadow: `0 0 6px ${ACCENT}`,
        }}
      />
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export function TimeScrubber() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const simTimeMs = useStore((s) => s.simTimeMs);
  const simRate = useStore((s) => s.simRate);
  const viewMode = useStore((s) => s.viewMode);
  const scrubberMode = useStore((s) => s.scrubberMode);
  const planetarium = useStore((s) => s.planetarium);
  const historyLoading = useStore((s) => s.historyLoading);
  const setScrubberMode = useStore((s) => s.setScrubberMode);
  const setSimRate = useStore((s) => s.setSimRate);
  const returnToPresent = useStore((s) => s.returnToPresent);

  const [activeField, setActiveField] = useState<Field>('hour');
  const activeRef = useRef<Field>('hour');
  const selectField = (f: Field) => {
    activeRef.current = f;
    setActiveField(f);
  };

  useEffect(() => ensurePulseKeyframes(), []);

  // Pulse the "Return to Present" lifeline briefly when you first travel away.
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (viewMode !== 'review') {
      setPulse(false);
      return;
    }
    setPulse(true);
    const id = setTimeout(() => setPulse(false), 2400);
    return () => clearTimeout(id);
  }, [viewMode]);

  if (loadingPhase !== 'ready') return null;

  const isReview = viewMode === 'review';
  const isPaused = simRate === 0;

  return (
    <>
      {scrubberMode && (
        <>
          <TimePanel simTimeMs={simTimeMs} active={activeField} onSelect={selectField} />
          <ThumbWheel activeRef={activeRef} />
          {/* Field selector hint row, under the panel. */}
          <div
            style={{
              position: 'absolute',
              top: 58,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              gap: 6,
              pointerEvents: 'auto',
            }}
          >
            {FIELD_ORDER.map((f) => (
              <button
                key={f}
                onClick={() => selectField(f)}
                style={{
                  ...glass,
                  padding: '2px 8px',
                  borderRadius: 6,
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  cursor: 'pointer',
                  color: activeField === f ? '#fff' : 'rgba(255,255,255,0.55)',
                  borderColor: activeField === f ? ACCENT : 'rgba(255,255,255,0.12)',
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Status hint: a day-fetch in progress, or the intentional planetarium void. */}
      {(historyLoading || planetarium) && (
        <div
          style={{
            ...glass,
            position: 'absolute',
            bottom: 60,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '4px 12px',
            borderRadius: 8,
            fontSize: 11,
            color: 'rgba(255,255,255,0.62)',
            whiteSpace: 'nowrap',
          }}
        >
          {historyLoading ? 'Loading day…' : 'No catalog for this date — showing sky only'}
        </div>
      )}

      {/* Bottom control cluster — always present once ready. */}
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <button
          onClick={() => setScrubberMode(!scrubberMode)}
          title={scrubberMode ? 'Close time controls' : 'Time controls'}
          aria-label="Toggle time scrubber"
          style={{
            ...iconBtn,
            color: scrubberMode ? '#fff' : 'rgba(255,255,255,0.7)',
            background: scrubberMode ? 'rgba(99,179,237,0.25)' : glass.background,
            borderColor: scrubberMode ? ACCENT : 'rgba(255,255,255,0.12)',
          }}
        >
          <ClockIcon />
        </button>

        <button
          onClick={() => setSimRate(isPaused ? 1 : 0)}
          title={isPaused ? 'Play' : 'Pause'}
          aria-label={isPaused ? 'Play' : 'Pause'}
          style={iconBtn}
        >
          {isPaused ? '▶' : '⏸'}
        </button>

        {isReview && (
          <button
            onClick={() => {
              returnToPresent();
              setScrubberMode(false);
            }}
            title="Snap simulation back to wall-clock"
            style={{
              ...glass,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              height: 32,
              padding: '0 14px',
              borderRadius: 16,
              fontSize: 11,
              letterSpacing: '0.04em',
              color: '#fff',
              borderColor: 'rgba(99,179,237,0.55)',
              cursor: 'pointer',
              animation: pulse ? 'ow-pill-pulse 1.1s ease-in-out infinite' : 'none',
            }}
          >
            <ReturnIcon />
            Return to Present
          </button>
        )}
      </div>
    </>
  );
}
