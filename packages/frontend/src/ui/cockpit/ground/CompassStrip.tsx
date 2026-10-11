import { useMemo } from 'react';
import { lookAnglesAt, pickCurrentPass } from '../../../sky/passes';
import { isDomeView, useStore } from '../../../store/useStore';
import { edgeMark, riseSetBearings, visibleTicks, type EdgeMark } from './compass';

/**
 * Flat compass strip, ground (dome) view only: an exact heading readout that
 * complements the world-locked 3D horizon markers. The heading comes from
 * observerHeadingRad, published when the gaze changes, so this re-renders on
 * drag, not per frame. RISE (green) / SET (amber) sit at the pass's HORIZON
 * bearings; off-span they become edge arrows. A clipped pass end gets no mark
 * (it is the edge of the search window, not a real crossing).
 */
const LABEL_FONT = 'monospace';
const SHADOW = '0 1px 4px rgba(0,0,0,0.9)';

export function CompassStrip() {
  const show = useStore((s) => s.loadingPhase === 'ready' && isDomeView(s));
  if (!show) return null;
  return <Strip />;
}

function Strip() {
  const headingRad = useStore((s) => s.observerHeadingRad);
  const pass = useStore((s) => pickCurrentPass(s.nextPasses, s.simTimeMs));
  const selected = useStore((s) => s.selectedSatellite);
  const observer = useStore((s) => s.observerLocation);

  const bearings = useMemo(
    () =>
      riseSetBearings(pass, (ms) =>
        selected && observer
          ? (lookAnglesAt(selected.omm, { latDeg: observer.lat, lonDeg: observer.lon, altKm: observer.alt }, ms)?.azimuthDeg ?? null)
          : null,
      ),
    [pass, selected, observer],
  );

  const headingDeg = (headingRad * 180) / Math.PI;
  const rise = edgeMark(bearings.rise, headingDeg);
  const set = edgeMark(bearings.set, headingDeg);

  return (
    <div
      style={{
        position: 'absolute',
        top: 14,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(620px, 78vw)',
        height: 44,
        pointerEvents: 'none',
      }}
    >
      {/* The edge fade is on an inner element: it must not fade the off-span arrows, which live at the edges. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          maskImage: 'linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)',
          WebkitMaskImage: 'linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)',
        }}
      >
        {visibleTicks(headingDeg).map((t) => {
          const north = t.label === 'N';
          return (
            <Column key={t.deg} xPct={t.xPct}>
              {t.label ? (
                <span
                  style={{
                    fontFamily: LABEL_FONT,
                    fontSize: t.major ? (t.label.length > 1 ? 12 : 15) : 11,
                    fontWeight: 700,
                    color: north ? 'var(--hud-north)' : 'var(--hud-compass-label)',
                    textShadow: SHADOW,
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
                  background: north ? 'var(--hud-north)' : 'var(--hud-compass-tick)',
                  opacity: t.major ? 0.9 : 0.5,
                }}
              />
            </Column>
          );
        })}

        {/* Gaze marker. */}
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
            borderBottom: '7px solid rgba(255, 255, 255, 0.9)',
          }}
        />

        <PassMark mark={rise} label="RISE" color="var(--hud-good)" />
        <PassMark mark={set} label="SET" color="var(--hud-warn)" />
      </div>

      <EdgeArrow mark={rise} color="var(--hud-good)" top={4} />
      <EdgeArrow mark={set} color="var(--hud-warn)" top={22} />
    </div>
  );
}

function Column({ xPct, children }: { xPct: number; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${xPct}%`,
        top: 0,
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
      }}
    >
      {children}
    </div>
  );
}

function PassMark({ mark, label, color }: { mark: EdgeMark; label: string; color: string }) {
  if (mark?.kind !== 'on') return null;
  return (
    <Column xPct={mark.xPct}>
      <span style={{ fontFamily: LABEL_FONT, fontSize: 11, fontWeight: 700, color, textShadow: SHADOW, letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ width: 1, height: 12, background: color, opacity: 0.9 }} />
    </Column>
  );
}

function EdgeArrow({ mark, color, top }: { mark: EdgeMark; color: string; top: number }) {
  if (mark?.kind !== 'off') return null;
  return (
    <div
      style={{
        position: 'absolute',
        [mark.side]: -14,
        top,
        fontSize: 13,
        fontWeight: 700,
        color,
        textShadow: SHADOW,
      }}
    >
      {mark.side === 'left' ? '◄' : '►'}
    </div>
  );
}
