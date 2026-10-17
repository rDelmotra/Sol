import { useEffect, useId, useMemo, useState } from 'react';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { ER_KM, orbitPoint3D, orbitPosition, orbitShape } from '@orbitwatch/orbital-core';
import { orbitElementsFromOmm } from '../../../sky/orbit-elements';
import { useStore } from '../../../store/useStore';

/**
 * The selected object's orbit in 3D, to scale, and STILL: a shaded Earth (pole
 * up, never tilted), the orbit with its true inclination, RAAN and argument of
 * perigee, over the equatorial plane drawn as a dense radial web, seen from
 * 7 degrees above that plane at a fixed turn.
 *
 * The stretch of the orbit hidden by the planet's disc is dimmed; the rest of the
 * far side stays full white. Orthographic; the view is fitted to the orbit's own
 * outline so any orbit fills the card. Only the object dot moves (once a second).
 */

const W = 200;
const H = 130;
const PAD = 12;
const TILT = (7 * Math.PI) / 180; // camera elevation above the equatorial plane
const TURN = 0.6; // fixed turn about the pole (rad)
const SAMPLES = 160;
const WEB_RINGS = 16;
const WEB_SPOKES = 60;
const MARKER_MS = 1000;

interface P {
  sx: number;
  sy: number;
  /** >0 = nearer the camera than the Earth's centre. */
  d: number;
}
interface V { x: number; y: number; z: number }

const cosT = Math.cos(TILT);
const sinT = Math.sin(TILT);
const cosS = Math.cos(TURN);
const sinS = Math.sin(TURN);

/** Earth-fixed-axis point (km) to unscaled view coords; the turn is about the pole. */
function raw(p: V) {
  const x = p.x * cosS - p.y * sinS;
  const y = p.x * sinS + p.y * cosS;
  return { x, y: -(p.z * cosT + y * sinT), d: -y * cosT + p.z * sinT };
}

function toPath(pts: P[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.sx.toFixed(2)} ${p.sy.toFixed(2)}`).join(' ');
}

export function OrbitDiagram({ object }: { object: EnrichedTLEObject }) {
  const el = useMemo(() => orbitElementsFromOmm(object.omm), [object]);
  if (!el || !orbitShape(el)) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', fontSize: 9, letterSpacing: '0.2em', color: 'var(--hud-text-dim)', fontFamily: 'var(--font-hud-mono)' }}>
        NO ORBIT SOLUTION
      </div>
    );
  }
  return <Diagram el={el} />;
}

function Diagram({ el }: { el: NonNullable<ReturnType<typeof orbitElementsFromOmm>> }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  const g = useMemo(() => {
    const shape = orbitShape(el)!;
    const { a, e } = shape;
    const rawPts: { x: number; y: number; d: number }[] = [];
    for (let k = 0; k <= SAMPLES; k++) {
      const E = (k / SAMPLES) * 2 * Math.PI;
      const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
      const p3 = orbitPoint3D(el, a * (1 - e * Math.cos(E)), nu);
      if (!p3) return null;
      rawPts.push(raw(p3));
    }

    let x0 = -ER_KM, x1 = ER_KM, y0 = -ER_KM, y1 = ER_KM;
    for (const p of rawPts) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    const s = Math.min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (y1 - y0));
    const cx = W / 2 - ((x0 + x1) / 2) * s;
    const cy = H / 2 - ((y0 + y1) / 2) * s;
    const project = (p: V): P => {
      const q = raw(p);
      return { sx: cx + q.x * s, sy: cy + q.y * s, d: q.d };
    };
    const pts: P[] = rawPts.map((q) => ({ sx: cx + q.x * s, sy: cy + q.y * s, d: q.d }));

    // Split into runs by side of the Earth, overlapping by one point so there is no gap.
    const runs: { front: boolean; d: string }[] = [];
    let cur: { front: boolean; pts: P[] } | null = null;
    for (let k = 0; k < pts.length; k++) {
      const front = pts[k].d >= 0;
      if (!cur || cur.front !== front) {
        if (cur) {
          cur.pts.push(pts[k]);
          runs.push({ front: cur.front, d: toPath(cur.pts) });
        }
        cur = { front, pts: k > 0 ? [pts[k - 1]] : [] };
      }
      cur.pts.push(pts[k]);
    }
    if (cur) runs.push({ front: cur.front, d: toPath(cur.pts) });

    const webR = (W / 2 + Math.abs(cx - W / 2)) / s;
    const ring = (R: number) =>
      toPath(Array.from({ length: 73 }, (_, k) => project({ x: R * Math.cos((k / 72) * 2 * Math.PI), y: R * Math.sin((k / 72) * 2 * Math.PI), z: 0 })));
    const rings = Array.from({ length: WEB_RINGS }, (_, k) => ring((webR * (k + 1)) / WEB_RINGS));
    const spokes = Array.from({ length: WEB_SPOKES }, (_, k) => {
      const t = (k / WEB_SPOKES) * 2 * Math.PI;
      return toPath([project({ x: 0, y: 0, z: 0 }), project({ x: webR * Math.cos(t), y: webR * Math.sin(t), z: 0 })]);
    });
    return { runs, rings, spokes, cx, cy, earthR: ER_KM * s, project };
  }, [el]);

  // The dot: refreshed once a second, no animation loop; paused while the tab is hidden.
  const [simMs, setSimMs] = useState(() => useStore.getState().simTimeMs);
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) setSimMs(useStore.getState().simTimeMs);
    }, MARKER_MS);
    return () => clearInterval(id);
  }, []);

  if (!g) return null;
  const { runs, rings, spokes, cx, cy, earthR, project } = g;
  const pos = orbitPosition(el, simMs);
  const q = pos ? orbitPoint3D(el, pos.r, pos.trueAnomaly) : null;
  const objP = q ? project(q) : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ height: '100%', width: '100%', fontFamily: 'var(--font-hud-mono)' }}>
      <defs>
        <clipPath id={`${uid}in`}><circle cx={cx} cy={cy} r={earthR} /></clipPath>
        <clipPath id={`${uid}out`}>
          <path clipRule="evenodd" d={`M 0 0 H ${W} V ${H} H 0 Z M ${cx - earthR} ${cy} a ${earthR} ${earthR} 0 1 0 ${2 * earthR} 0 a ${earthR} ${earthR} 0 1 0 ${-2 * earthR} 0 Z`} />
        </clipPath>
        <radialGradient id={`${uid}shade`} cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="var(--hud-arc)" stopOpacity={0.27} />
          <stop offset="0.55" stopColor="var(--hud-arc)" stopOpacity={0.24} />
          <stop offset="1" stopColor="var(--hud-arc)" stopOpacity={0.21} />
        </radialGradient>
      </defs>

      {/* The equatorial plane as a radial web: faint reference, not the subject. */}
      <g fill="none" stroke="var(--hud-arc)">
        {rings.map((d, i) => (
          <path key={`wr${i}`} d={d} strokeWidth={0.3} opacity={0.23 * (1 - i / (WEB_RINGS + 2))} />
        ))}
        {spokes.map((d, i) => (
          <path key={`ws${i}`} d={d} strokeWidth={0.25} opacity={0.15} />
        ))}
      </g>

      {/* Behind the Earth: full white where visible, dimmed where the disc covers it. */}
      {runs.filter((r) => !r.front).map((r, i) => (
        <g key={`b${i}`} fill="none" stroke="#fff" strokeWidth={0.9}>
          <path d={r.d} clipPath={`url(#${uid}out)`} />
          <path d={r.d} clipPath={`url(#${uid}in)`} opacity={0.4} />
        </g>
      ))}
      {objP && objP.d < 0 && <Marker p={objP} dim />}

      <circle cx={cx} cy={cy} r={earthR} fill={`url(#${uid}shade)`} stroke="var(--hud-arc-dim)" strokeWidth={0.5} />

      {runs.filter((r) => r.front).map((r, i) => (
        <path key={`f${i}`} d={r.d} fill="none" stroke="#fff" strokeWidth={0.9} />
      ))}
      {objP && objP.d >= 0 && <Marker p={objP} />}

      {/* Centre of mass. */}
      <circle cx={cx} cy={cy} r={3.2} fill="oklch(0.85 0.12 235)" opacity={0.18} />
      <circle cx={cx} cy={cy} r={1.5} fill="oklch(0.9 0.1 235)" />
    </svg>
  );
}

function Marker({ p, dim }: { p: P; dim?: boolean }) {
  return (
    <g opacity={dim ? 0.5 : 1}>
      <circle cx={p.sx} cy={p.sy} r={5} fill="var(--hud-arc)" opacity={0.25} />
      <circle cx={p.sx} cy={p.sy} r={4} fill="none" stroke="var(--hud-arc)" strokeWidth={0.5} opacity={0.8} />
      <circle cx={p.sx} cy={p.sy} r={2} fill="#fff" />
    </g>
  );
}
