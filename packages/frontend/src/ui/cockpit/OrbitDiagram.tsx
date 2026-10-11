import { useId, useLayoutEffect, useMemo, useRef } from 'react';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { orbitElementsFromOmm } from '../../sky/orbit-elements';
import { useStore } from '../../store/useStore';
import {
  SPIN_DEG_PER_S,
  SPIN_START_RAD,
  VIEW_H,
  VIEW_W,
  WEB_RINGS,
  WEB_SPOKES,
  frameFor,
  prepareOrbit,
} from './orbit-diagram';

/** Spin redraws at about 30 fps: plenty for a slow turn in a small card. */
const FRAME_MS = 33;

/**
 * The locked object's orbit in 3D, to scale, seen from 5° above the equator and
 * slowly turning (7°/s). Geometry is computed once per object; the spin is
 * driven by one requestAnimationFrame loop that writes SVG attributes through
 * refs, so React never re-renders at animation rate. The marker follows the sim
 * clock, read from the store inside the loop (no subscription).
 */
export function OrbitDiagram({ object }: { object: EnrichedTLEObject }) {
  const prep = useMemo(() => {
    const el = orbitElementsFromOmm(object.omm);
    return el ? prepareOrbit(el) : null;
  }, [object]);

  if (!prep) {
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          fontSize: 9,
          letterSpacing: '0.2em',
          color: 'var(--hud-text-dim)',
          fontFamily: 'var(--font-hud-mono)',
        }}
      >
        NO ORBIT SOLUTION
      </div>
    );
  }
  return <Diagram prep={prep} />;
}

function Diagram({ prep }: { prep: NonNullable<ReturnType<typeof prepareOrbit>> }) {
  // useId contains colons; keep the ids plain so url(#…) is safe everywhere.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const insideId = `${uid}-in`;
  const outsideId = `${uid}-out`;
  const shadeId = `${uid}-shade`;

  const insideCircle = useRef<SVGCircleElement>(null);
  const outsidePath = useRef<SVGPathElement>(null);
  const rings = useRef<(SVGPathElement | null)[]>([]);
  const spokes = useRef<(SVGPathElement | null)[]>([]);
  const backOut = useRef<SVGPathElement>(null);
  const backIn = useRef<SVGPathElement>(null);
  const frontLine = useRef<SVGPathElement>(null);
  const earth = useRef<SVGCircleElement>(null);
  const com = useRef<SVGGElement>(null);
  const markerBack = useRef<SVGGElement>(null);
  const markerFront = useRef<SVGGElement>(null);

  useLayoutEffect(() => {
    let spin = SPIN_START_RAD;
    let drawnSpin = NaN;
    let drawnTime = NaN;
    let last = performance.now();
    let acc = 0;
    let raf = 0;

    const draw = () => {
      const atMs = useStore.getState().simTimeMs;
      if (spin === drawnSpin && atMs === drawnTime) return;
      drawnSpin = spin;
      drawnTime = atMs;
      const f = frameFor(prep, spin, atMs);
      const { cx, cy, r } = f.earth;
      for (const c of [insideCircle.current, earth.current]) {
        c?.setAttribute('cx', String(cx));
        c?.setAttribute('cy', String(cy));
        c?.setAttribute('r', String(r));
      }
      outsidePath.current?.setAttribute('d', f.outside);
      rings.current.forEach((p, i) => p?.setAttribute('d', f.rings[i] ?? ''));
      spokes.current.forEach((p, i) => p?.setAttribute('d', f.spokes[i] ?? ''));
      for (const p of [backOut.current, backIn.current]) p?.setAttribute('d', f.back);
      frontLine.current?.setAttribute('d', f.front);
      com.current?.setAttribute('transform', `translate(${cx} ${cy})`);
      const m = f.marker;
      const place = (g: SVGGElement | null, show: boolean) => {
        if (!g) return;
        g.setAttribute('display', show && m ? 'inline' : 'none');
        if (m) g.setAttribute('transform', `translate(${m.sx} ${m.sy})`);
      };
      place(markerBack.current, !!m && m.d < 0);
      place(markerFront.current, !!m && m.d >= 0);
    };

    const tick = (now: number) => {
      acc += now - last;
      last = now;
      if (acc >= FRAME_MS) {
        spin += ((SPIN_DEG_PER_S * Math.PI) / 180) * (acc / 1000);
        acc = 0;
        draw();
      }
      raf = requestAnimationFrame(tick);
    };
    draw();
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [prep]);

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} style={{ height: '100%', width: '100%', fontFamily: 'var(--font-hud-mono)' }}>
      <defs>
        <clipPath id={insideId}>
          <circle ref={insideCircle} />
        </clipPath>
        <clipPath id={outsideId}>
          <path ref={outsidePath} clipRule="evenodd" />
        </clipPath>
        <radialGradient id={shadeId} cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="var(--hud-arc)" stopOpacity={0.27} />
          <stop offset="0.55" stopColor="var(--hud-arc)" stopOpacity={0.24} />
          <stop offset="1" stopColor="var(--hud-arc)" stopOpacity={0.21} />
        </radialGradient>
      </defs>

      {/* The equatorial plane as a radial web, so an inclined orbit visibly tilts out of it. Faint: a reference, not a subject. */}
      <g fill="none" stroke="var(--hud-arc)">
        {Array.from({ length: WEB_RINGS }, (_, i) => (
          <path
            key={`wr${i}`}
            ref={(el) => {
              rings.current[i] = el;
            }}
            strokeWidth={0.3}
            opacity={0.23 * (1 - i / (WEB_RINGS + 2))}
          />
        ))}
        {Array.from({ length: WEB_SPOKES }, (_, i) => (
          <path
            key={`ws${i}`}
            ref={(el) => {
              spokes.current[i] = el;
            }}
            strokeWidth={0.25}
            opacity={0.15}
          />
        ))}
      </g>

      {/* Far side first, so the sphere covers it; only the stretch hidden by the disc is dimmed. */}
      <g fill="none" stroke="#fff" strokeWidth={0.9}>
        <path ref={backOut} clipPath={`url(#${outsideId})`} />
        <path ref={backIn} clipPath={`url(#${insideId})`} opacity={0.4} />
      </g>
      <Marker gRef={markerBack} dim />

      {/* The Earth: a plain shaded sphere, same hue as the web. */}
      <circle ref={earth} fill={`url(#${shadeId})`} stroke="var(--hud-arc-dim)" strokeWidth={0.5} />

      {/* Near side, then the marker on top. */}
      <path ref={frontLine} fill="none" stroke="#fff" strokeWidth={0.9} />
      <Marker gRef={markerFront} />

      {/* Centre of mass: the point everything orbits. */}
      <g ref={com}>
        <circle r={3.2} fill="oklch(0.85 0.12 235)" opacity={0.18} />
        <circle r={1.5} fill="oklch(0.9 0.1 235)" />
      </g>
    </svg>
  );
}

/** Object marker at the group's origin; the loop moves the group. Pulses via SMIL. */
function Marker({ gRef, dim }: { gRef: React.RefObject<SVGGElement>; dim?: boolean }) {
  return (
    <g ref={gRef} display="none" opacity={dim ? 0.5 : 1}>
      <circle r={4} fill="var(--hud-arc)" opacity={0.3}>
        <animate attributeName="r" values="3;7;3" dur="1.6s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0.05;0.5" dur="1.6s" repeatCount="indefinite" />
      </circle>
      <circle r={4} fill="none" stroke="var(--hud-arc)" strokeWidth={0.5} opacity={0.8} />
      <circle r={2} fill="#fff">
        <animate attributeName="opacity" values="1;0.65;1" dur="1.6s" repeatCount="indefinite" />
      </circle>
    </g>
  );
}
