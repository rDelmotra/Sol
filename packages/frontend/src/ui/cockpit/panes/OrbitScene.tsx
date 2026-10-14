import type { ReactNode, RefObject } from 'react';
import { DEPTH_OPACITY, VIEW_H, VIEW_W, type Label, type OrbitLayout } from './orbit-diagram';

const CYAN = 'oklch(0.85 0.12 235)';
const LABEL_STYLE = { fontSize: 6.5 } as const;

/**
 * The still picture of one orbit card, drawn from a finished `OrbitLayout`.
 * Pure markup: no store, no timers, no state. It lives apart from
 * OrbitDiagram.tsx so it can be rendered on its own (tests, review scripts).
 * `uid` keeps the clip-path ids unique when several cards are on screen. The two
 * marker groups start hidden; the parent moves them.
 */
export function OrbitScene({
  layout: L,
  uid,
  markerBack,
  markerFront,
}: {
  layout: OrbitLayout;
  uid: string;
  markerBack?: RefObject<SVGGElement>;
  markerFront?: RefObject<SVGGElement>;
}) {
  const insideId = `${uid}-in`;
  const outsideId = `${uid}-out`;
  const shadeId = `${uid}-shade`;

  const { earth } = L;
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} style={{ height: '100%', width: '100%', fontFamily: 'var(--font-hud-mono)' }}>
      <defs>
        <clipPath id={insideId}>
          <circle cx={earth.cx} cy={earth.cy} r={earth.r} />
        </clipPath>
        <clipPath id={outsideId}>
          <path d={L.outside} clipRule="evenodd" />
        </clipPath>
        <radialGradient id={shadeId} cx="36%" cy="30%" r="80%">
          <stop offset="0" stopColor="var(--hud-arc)" stopOpacity={0.36} />
          <stop offset="0.5" stopColor="var(--hud-arc)" stopOpacity={0.21} />
          <stop offset="1" stopColor="var(--hud-arc)" stopOpacity={0.07} />
        </radialGradient>
      </defs>

      {/* Far side first, so the sphere covers it. Dashed; the stretch behind the disc is dimmer still. */}
      <g fill="none" stroke="var(--hud-arc)" strokeWidth={0.5} strokeDasharray="2.2 2.6">
        <path d={L.equatorFar} clipPath={`url(#${outsideId})`} opacity={0.3} />
        <path d={L.equatorFar} clipPath={`url(#${insideId})`} opacity={0.14} />
      </g>
      <g fill="none" stroke="#fff" strokeWidth={0.75} strokeDasharray="2.2 2.6">
        <path d={L.far} clipPath={`url(#${outsideId})`} opacity={DEPTH_OPACITY.far} />
        <path d={L.far} clipPath={`url(#${insideId})`} opacity={DEPTH_OPACITY.hidden} />
      </g>
      <Marker gRef={markerBack} dim />

      {/* The Earth: a plain shaded sphere, same hue as the equatorial ring. */}
      <circle cx={earth.cx} cy={earth.cy} r={earth.r} fill={`url(#${shadeId})`} stroke="var(--hud-arc-dim)" strokeWidth={0.5} />

      {/* Near side of the equatorial ring, and the north pole. */}
      <path d={L.equatorNear} fill="none" stroke="var(--hud-arc)" strokeWidth={0.6} opacity={0.5} />
      <g opacity={DEPTH_OPACITY[L.pole.depth]}>
        <path
          d={`M ${L.pole.base.sx.toFixed(2)} ${L.pole.base.sy.toFixed(2)} L ${L.pole.tip.sx.toFixed(2)} ${L.pole.tip.sy.toFixed(2)}`}
          stroke="var(--hud-arc)"
          strokeWidth={0.8}
          strokeDasharray={L.pole.depth === 'near' ? undefined : '1.5 1.5'}
        />
        {L.pole.depth === 'near' && <circle cx={L.pole.base.sx} cy={L.pole.base.sy} r={1.2} fill="var(--hud-arc)" />}
        <Text at={L.pole.label} anchor="middle" fill="var(--hud-text-dim)">
          N
        </Text>
      </g>

      {/* Near half of the orbit: solid and bright, with a dark edge so it stands off the sphere. */}
      <path d={L.near} fill="none" stroke="var(--hud-sky-deep)" strokeWidth={3} strokeOpacity={0.5} strokeLinecap="round" />
      <path d={L.near} fill="none" stroke="#fff" strokeWidth={1.4} strokeLinecap="round" />

      {/* Direction of motion. */}
      {L.chevrons.map((c, i) => (
        <path
          key={i}
          d="M -2.4 -2.1 L 0.6 0 L -2.4 2.1"
          transform={`translate(${c.sx.toFixed(2)} ${c.sy.toFixed(2)}) rotate(${c.angleDeg.toFixed(1)})`}
          fill="none"
          stroke="#fff"
          strokeWidth={0.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={DEPTH_OPACITY[c.depth]}
        />
      ))}

      {/* Ascending node (always on the left) and perigee (eccentric orbits only). */}
      <circle cx={L.node.at.sx} cy={L.node.at.sy} r={1.8} fill={CYAN} />
      <Text at={L.node.label} anchor="end" fill={CYAN}>
        AN
      </Text>
      {L.perigee && (
        <>
          <path
            d={`M ${L.perigee.at.sx.toFixed(2)} ${L.perigee.at.sy.toFixed(2)} L ${L.perigee.tip.sx.toFixed(2)} ${L.perigee.tip.sy.toFixed(2)}`}
            stroke={CYAN}
            strokeWidth={1}
            opacity={DEPTH_OPACITY[L.perigee.depth]}
          />
          {/* The label sits outside the disc, so it stays readable even when the tick is hidden. */}
          <g opacity={L.perigee.depth === 'near' ? 1 : DEPTH_OPACITY.far}>
            <Text at={L.perigee.label} anchor="middle" fill={CYAN}>
              PE
            </Text>
          </g>
        </>
      )}

      <Text at={L.inclination.at} anchor="start" fill="var(--hud-text-dim)">
        {L.inclination.text}
      </Text>

      <Marker gRef={markerFront} />
    </svg>
  );
}

/** Small label with a thin dark halo so it stays readable over the sphere and lines. */
function Text({ at, anchor, fill, children }: { at: Label; anchor: 'start' | 'middle' | 'end'; fill: string; children: ReactNode }) {
  return (
    <text
      x={at.sx}
      y={at.sy}
      textAnchor={anchor}
      fill={fill}
      stroke="var(--hud-sky-deep)"
      strokeWidth={1.6}
      strokeOpacity={0.7}
      strokeLinejoin="round"
      paintOrder="stroke"
      style={LABEL_STYLE}
    >
      {children}
    </text>
  );
}

/** The object: a plain dot with a thin static ring, at the group's origin; the 1 Hz update moves the group. */
function Marker({ gRef, dim }: { gRef?: RefObject<SVGGElement>; dim?: boolean }) {
  return (
    <g ref={gRef} display="none" opacity={dim ? 0.5 : 1}>
      <circle r={4} fill="none" stroke="var(--hud-arc)" strokeWidth={0.5} opacity={0.8} />
      <circle r={2} fill="#fff" />
    </g>
  );
}
