import { useId, useLayoutEffect, useMemo, useRef } from 'react';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { orbitElementsFromOmm } from '../../../sky/orbit-elements';
import { useStore } from '../../../store/useStore';
import {
  MARKER_INTERVAL_MS,
  layoutOrbit,
  markerAt,
  prepareOrbit,
  type PreparedOrbit,
  type Sp,
} from './orbit-diagram';
import { OrbitScene } from './OrbitScene';

/**
 * The locked object's orbit in 3D, to scale, and STILL. The camera is tied to
 * the orbit plane (see orbit-diagram.ts), so the card needs no motion to be
 * unambiguous: near half solid, far half dashed, Earth with its tilted equator
 * ring. All geometry is computed once per object and rendered by React. Only
 * the object dot moves, once a second, through two refs (a plain setInterval,
 * no re-render, no animation loop, paused while the tab is hidden).
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

/** Move one marker group, or hide it when it is not on this side. */
function place(g: SVGGElement | null, at: Sp | null): void {
  if (!g) return;
  g.setAttribute('display', at ? 'inline' : 'none');
  if (at) g.setAttribute('transform', `translate(${at.sx.toFixed(2)} ${at.sy.toFixed(2)})`);
}

function Diagram({ prep }: { prep: PreparedOrbit }) {
  // useId contains colons; keep the ids plain so url(#…) is safe everywhere.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  const L = useMemo(() => layoutOrbit(prep), [prep]);
  const markerBack = useRef<SVGGElement>(null);
  const markerFront = useRef<SVGGElement>(null);

  useLayoutEffect(() => {
    const update = () => {
      if (document.hidden) return;
      const m = markerAt(prep, L.fit, useStore.getState().simTimeMs);
      place(markerBack.current, m && m.d < 0 ? m : null);
      place(markerFront.current, m && m.d >= 0 ? m : null);
    };
    update();
    const id = setInterval(update, MARKER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [prep, L]);

  return <OrbitScene layout={L} uid={uid} markerBack={markerBack} markerFront={markerFront} />;
}
