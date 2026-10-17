import { useEffect, useId, useMemo, useRef } from 'react';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { ER_KM, orbitPoint3D, orbitPosition, orbitShape } from '@orbitwatch/orbital-core';
import { orbitElementsFromOmm } from '../../../sky/orbit-elements';
import { useStore } from '../../../store/useStore';

/**
 * The selected object's orbit in 3D, to scale: a shaded Earth (pole up, never
 * tilted) and the equatorial plane as a dense radial web, both fixed, seen from
 * 7 degrees above that plane. ONLY the orbit arc turns, slowly about the pole, so
 * its tilt reads from every side (decision D13).
 *
 * The turn is cheap on purpose: 10 steps a second from one timer (no animation-frame
 * loop), paused while the tab is hidden, and the three arc paths and the dot are
 * written straight to the DOM through refs, so React never re-renders. The scale
 * is fitted once over a full turn, so the picture never rescales while it turns.
 * The stretch hidden by the planet's disc is dimmed; the rest of the far side is white.
 */

const W = 200;
const H = 130;
const PAD = 12;
const TILT = (7 * Math.PI) / 180; // camera elevation above the equatorial plane
const TURN_START = 0.6; // rad; also the fixed turn of the web
const TURN_RATE = (7 * Math.PI) / 180; // rad per second
const TURN_STEP_MS = 100; // 10 fps
const SAMPLES = 160;
const WEB_RINGS = 16;
const WEB_SPOKES = 60;

interface V { x: number; y: number; z: number }
interface P { sx: number; sy: number; d: number }

const cosT = Math.cos(TILT);
const sinT = Math.sin(TILT);

/** Earth-fixed-axis point (km) to unscaled view coords, turned by `turn` about the pole. */
function raw(p: V, turn: number) {
  const cs = Math.cos(turn);
  const sn = Math.sin(turn);
  const x = p.x * cs - p.y * sn;
  const y = p.x * sn + p.y * cs;
  return { x, y: -(p.z * cosT + y * sinT), d: -y * cosT + p.z * sinT };
}

function toPath(pts: P[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.sx.toFixed(2)} ${p.sy.toFixed(2)}`).join(' ');
}

/** The orbit at `turn` as three path strings: near side, and far side (whole). Runs are separate subpaths. */
function arcPaths(arc: V[], turn: number, cx: number, cy: number, s: number): { front: string; back: string } {
  const front: string[] = [];
  const back: string[] = [];
  let run: P[] = [];
  let runFront = true;
  const flush = () => {
    if (run.length > 1) (runFront ? front : back).push(toPath(run));
  };
  for (let k = 0; k < arc.length; k++) {
    const q = raw(arc[k], turn);
    const p: P = { sx: cx + q.x * s, sy: cy + q.y * s, d: q.d };
    const f = p.d >= 0;
    if (k > 0 && f !== runFront) {
      run.push(p); // overlap one point so the line has no gap at the crossing
      flush();
      run = [run[run.length - 1]];
    }
    runFront = f;
    run.push(p);
  }
  flush();
  return { front: front.join(' '), back: back.join(' ') };
}

type Elements = NonNullable<ReturnType<typeof orbitElementsFromOmm>>;

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

function Diagram({ el }: { el: Elements }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const frontRef = useRef<SVGPathElement>(null);
  const backOutRef = useRef<SVGPathElement>(null);
  const backInRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGGElement>(null);

  const g = useMemo(() => {
    const { a, e } = orbitShape(el)!;
    const arc: V[] = [];
    for (let k = 0; k <= SAMPLES; k++) {
      const E = (k / SAMPLES) * 2 * Math.PI;
      const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
      const p3 = orbitPoint3D(el, a * (1 - e * Math.cos(E)), nu);
      if (!p3) return null;
      arc.push(p3);
    }

    // Fit over a whole turn so the scale and centre never change while the arc turns.
    let x0 = -ER_KM, x1 = ER_KM, y0 = -ER_KM, y1 = ER_KM;
    for (let t = 0; t < 24; t++) {
      for (const p of arc) {
        const q = raw(p, (t / 24) * 2 * Math.PI);
        x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
        y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
      }
    }
    const s = Math.min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (y1 - y0));
    const cx = W / 2 - ((x0 + x1) / 2) * s;
    const cy = H / 2 - ((y0 + y1) / 2) * s;

    // The web is fixed; rings are unchanged by any turn, spokes stay at the start turn.
    const proj = (p: V): P => {
      const q = raw(p, TURN_START);
      return { sx: cx + q.x * s, sy: cy + q.y * s, d: q.d };
    };
    const webR = (W / 2 + Math.abs(cx - W / 2)) / s;
    const ring = (R: number) =>
      toPath(Array.from({ length: 73 }, (_, k) => proj({ x: R * Math.cos((k / 72) * 2 * Math.PI), y: R * Math.sin((k / 72) * 2 * Math.PI), z: 0 })));
    const rings = Array.from({ length: WEB_RINGS }, (_, k) => ring((webR * (k + 1)) / WEB_RINGS));
    const spokes = Array.from({ length: WEB_SPOKES }, (_, k) => {
      const t = (k / WEB_SPOKES) * 2 * Math.PI;
      return toPath([proj({ x: 0, y: 0, z: 0 }), proj({ x: webR * Math.cos(t), y: webR * Math.sin(t), z: 0 })]);
    });
    return { arc, s, cx, cy, earthR: ER_KM * s, rings, spokes, first: arcPaths(arc, TURN_START, cx, cy, s) };
  }, [el]);

  useEffect(() => {
    if (!g) return;
    const t0 = performance.now();
    const step = () => {
      if (document.hidden) return;
      const turn = TURN_START + (TURN_RATE * (performance.now() - t0)) / 1000;
      const { front, back } = arcPaths(g.arc, turn, g.cx, g.cy, g.s);
      frontRef.current?.setAttribute('d', front);
      backOutRef.current?.setAttribute('d', back);
      backInRef.current?.setAttribute('d', back);
      const pos = orbitPosition(el, useStore.getState().simTimeMs);
      const p3 = pos ? orbitPoint3D(el, pos.r, pos.trueAnomaly) : null;
      const dot = dotRef.current;
      if (dot) {
        if (p3) {
          const q = raw(p3, turn);
          dot.setAttribute('transform', `translate(${(g.cx + q.x * g.s).toFixed(2)} ${(g.cy + q.y * g.s).toFixed(2)})`);
          dot.setAttribute('opacity', q.d >= 0 ? '1' : '0.5');
          dot.setAttribute('display', 'inline');
        } else {
          dot.setAttribute('display', 'none');
        }
      }
    };
    step();
    const id = setInterval(step, TURN_STEP_MS);
    return () => clearInterval(id);
  }, [g, el]);

  if (!g) return null;
  const { cx, cy, earthR, rings, spokes, first } = g;

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

      {/* The equatorial plane as a radial web: fixed, faint reference. */}
      <g fill="none" stroke="var(--hud-arc)">
        {rings.map((d, i) => (
          <path key={`wr${i}`} d={d} strokeWidth={0.3} opacity={0.23 * (1 - i / (WEB_RINGS + 2))} />
        ))}
        {spokes.map((d, i) => (
          <path key={`ws${i}`} d={d} strokeWidth={0.25} opacity={0.15} />
        ))}
      </g>

      {/* Far side of the orbit: white where visible, dimmed where the Earth's disc covers it. */}
      <g fill="none" stroke="#fff" strokeWidth={0.9}>
        <path ref={backOutRef} d={first.back} clipPath={`url(#${uid}out)`} />
        <path ref={backInRef} d={first.back} clipPath={`url(#${uid}in)`} opacity={0.4} />
      </g>

      <circle cx={cx} cy={cy} r={earthR} fill={`url(#${uid}shade)`} stroke="var(--hud-arc-dim)" strokeWidth={0.5} />

      {/* Near side of the orbit, over the Earth. */}
      <path ref={frontRef} d={first.front} fill="none" stroke="#fff" strokeWidth={0.9} />

      {/* The object: a plain dot that rides the arc as it turns. */}
      <g ref={dotRef} display="none">
        <circle r={5} fill="var(--hud-arc)" opacity={0.25} />
        <circle r={4} fill="none" stroke="var(--hud-arc)" strokeWidth={0.5} opacity={0.8} />
        <circle r={2} fill="#fff" />
      </g>

      {/* Centre of mass. */}
      <circle cx={cx} cy={cy} r={3.2} fill="oklch(0.85 0.12 235)" opacity={0.18} />
      <circle cx={cx} cy={cy} r={1.5} fill="oklch(0.9 0.1 235)" />
    </svg>
  );
}
