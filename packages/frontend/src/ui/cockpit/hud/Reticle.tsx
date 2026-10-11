import { useMemo } from 'react';
import { useStore } from '../../../store/useStore';
import { RETICLE_BOX_PX, RETICLE_RING_RADIUS_PX } from '../../../constants/reticle';
import { altitudeReading, elementOrbit, groupInt, kindCode } from '../format';
import {
  RETICLE_BRACKETS,
  RETICLE_LABEL_GAP,
  RETICLE_PLUS_PX,
  RETICLE_VIEWBOX,
  ringRadiusInViewBox,
} from '../layout';

/** Ring radius in drawing units. The engine picks inside exactly RETICLE_RING_RADIUS_PX. */
const RING_R = ringRadiusInViewBox(RETICLE_RING_RADIUS_PX, RETICLE_BOX_PX);

/**
 * Screen-centre reticle: corner brackets, centre plus, dotted capture ring and
 * a two-line label. Three states: locked (a selection), candidate (gamepad
 * soft-lock under the ring, pad connected only), none.
 */
export function Reticle() {
  const selected = useStore((s) => s.selectedSatellite);
  const liveAltitudeKm = useStore((s) => s.liveAltitudeKm);
  const liveSpeedKmS = useStore((s) => s.liveSpeedKmS);
  const gamepadConnected = useStore((s) => s.gamepadConnected);
  const candidateName = useStore((s) => (s.gamepadConnected ? s.reticleCandidateName : null));
  const candidateCount = useStore((s) => (s.gamepadConnected ? s.reticleCandidates.length : 0));
  const meanAltKm = useMemo(() => (selected ? elementOrbit(selected).meanAltKm : null), [selected]);

  const candidate = !selected && gamepadConnected && candidateName ? candidateName : null;
  const bracketOpacity = selected ? 0.9 : candidate ? 0.75 : 0.4;
  const alt = altitudeReading(liveAltitudeKm, meanAltKm);

  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
      {/* Centre mark: a small plus on a 4 px anchor box. */}
      <div style={{ height: 4, width: 4, position: 'relative' }}>
        <svg
          width={RETICLE_PLUS_PX}
          height={RETICLE_PLUS_PX}
          viewBox="0 0 10 10"
          style={{ position: 'absolute', left: -3, top: -3, filter: 'drop-shadow(0 0 4px var(--hud-arc-glow))' }}
        >
          <path d="M 5 1 V 9 M 1 5 H 9" stroke="var(--hud-arc)" strokeWidth="1" fill="none" />
        </svg>
      </div>
      <svg
        width={RETICLE_BOX_PX}
        height={RETICLE_BOX_PX}
        viewBox={`0 0 ${RETICLE_VIEWBOX} ${RETICLE_VIEWBOX}`}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          animation: 'hud-pulse 4s ease-in-out infinite',
        }}
      >
        {RETICLE_BRACKETS.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="var(--hud-arc)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" opacity={bracketOpacity} />
        ))}
        <circle
          cx={RETICLE_VIEWBOX / 2}
          cy={RETICLE_VIEWBOX / 2}
          r={RING_R}
          fill="none"
          stroke="var(--hud-arc-dim)"
          strokeWidth="0.6"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: RETICLE_BOX_PX / 2 + RETICLE_LABEL_GAP,
          transform: 'translateX(-50%)',
          whiteSpace: 'nowrap',
          fontSize: 10,
          letterSpacing: '0.3em',
          fontFamily: 'var(--font-hud-mono)',
          color: 'var(--hud-text-dim)',
          textAlign: 'center',
        }}
      >
        {selected ? (
          <>
            <div style={{ color: 'var(--hud-text)' }}>{selected.name}</div>
            <div style={{ marginTop: 4 }}>
              {kindCode(selected.objectType)}
              {alt ? ` · ${alt.live ? '' : 'MEAN '}${groupInt(alt.km)} KM` : ''}
              {liveSpeedKmS !== null && Number.isFinite(liveSpeedKmS) ? ` · ${liveSpeedKmS.toFixed(2)} KM/S` : ''}
            </div>
          </>
        ) : candidate ? (
          <>
            <div style={{ color: 'var(--hud-text)' }}>{candidate}</div>
            <div style={{ marginTop: 4, opacity: 0.85 }}>
              [A] LOCK{candidateCount > 1 ? `  ·  L3/R3  ${candidateCount} IN RANGE` : ''}
            </div>
          </>
        ) : (
          <>
            <div>NO LOCK</div>
            <div style={{ marginTop: 4, opacity: 0.7 }}>SELECT A CONTACT · CLICK GLOBE</div>
          </>
        )}
      </div>
    </div>
  );
}
