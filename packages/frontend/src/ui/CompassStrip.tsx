import { useStore, isDomeView } from '../store/useStore';

/**
 * Flat HUD compass strip for dome mode — a distortion-free heading readout that
 * complements the world-locked 3D horizon markers. The 3D markers sit on the real
 * horizon (and foreshorten with perspective, like any planetarium); this 2D strip
 * stays perfectly uniform so the user always has an exact heading, even when looking
 * up at the zenith where the 3D horizon is off-screen.
 *
 * Heading comes from `observerHeadingRad` (radians, North→East), published by the
 * ObserverSkyController only when the gaze changes — so this re-renders on drag, not
 * per frame. Visible only in dome mode once the app is ready.
 */

/** How many degrees of azimuth the strip spans edge-to-edge. */
const VISIBLE_SPAN_DEG = 140;
/** Letters at the 8 compass points; everything else is a plain tick. */
const POINT_LABELS: Record<number, string> = {
  0: 'N',
  45: 'NE',
  90: 'E',
  135: 'SE',
  180: 'S',
  225: 'SW',
  270: 'W',
  315: 'NW',
};
const NORTH_COLOR = 'var(--ow-star)';
const TICK_COLOR = 'var(--ow-telemetry-line)';

/** Shortest signed angular difference, wrapped to [-180, 180]. */
function wrapDelta(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export function CompassStrip() {
  const domeView = useStore((s) => isDomeView(s));
  const loadingPhase = useStore((s) => s.loadingPhase);
  const headingRad = useStore((s) => s.observerHeadingRad);

  // Hidden outside the dome observer view (incl. joyride/fly-to out of dome).
  if (loadingPhase !== 'ready' || !domeView) return null;

  const headingDeg = (headingRad * 180) / Math.PI;
  const half = VISIBLE_SPAN_DEG / 2;

  // Ticks every 15°; only those within the visible span are drawn.
  const ticks: { key: number; xPct: number; label?: string; major: boolean }[] = [];
  for (let a = 0; a < 360; a += 15) {
    const delta = wrapDelta(a - headingDeg);
    if (Math.abs(delta) > half) continue;
    ticks.push({
      key: a,
      xPct: 50 + (delta / VISIBLE_SPAN_DEG) * 100,
      label: POINT_LABELS[a],
      major: a % 45 === 0,
    });
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 76,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(620px, 78vw)',
        height: 44,
        pointerEvents: 'none',
        userSelect: 'none',
        // Fade the strip toward its edges so ticks slide in/out smoothly.
        maskImage:
          'linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)',
        WebkitMaskImage:
          'linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)',
      }}
    >
      {ticks.map((t) => {
        const isNorth = t.label === 'N';
        return (
          <div
            key={t.key}
            style={{
              position: 'absolute',
              left: `${t.xPct}%`,
              top: 0,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
            }}
          >
            {t.label ? (
              <span
                style={{
                  fontFamily: 'var(--ow-font-mono)',
                  fontSize: t.major ? (t.label.length > 1 ? 12 : 15) : 11,
                  fontWeight: 700,
                  color: isNorth ? NORTH_COLOR : 'var(--ow-text-hi)',
                  textShadow: 'var(--ow-text-shadow-ambient)',
                  letterSpacing: '0.04em',
                }}
              >
                {t.label}
              </span>
            ) : (
              <span style={{ height: 15 }} />
            )}
            <span
              style={{
                width: 1,
                height: t.major ? 12 : 6,
                background: isNorth ? NORTH_COLOR : TICK_COLOR,
                opacity: t.major ? 0.9 : 0.5,
              }}
            />
          </div>
        );
      })}

      {/* Center indicator — marks the exact gaze heading. */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 0,
          transform: 'translateX(-50%)',
          width: 0,
          height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderBottom: '7px solid var(--ow-text-hi)',
        }}
      />
    </div>
  );
}
