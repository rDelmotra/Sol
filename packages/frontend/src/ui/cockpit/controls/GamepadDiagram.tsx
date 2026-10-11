import { useId, type CSSProperties, type ReactNode } from 'react';
import { partLook, type ActivePart, type GamepadPartId, type PartLook } from './controls-sheet';

/**
 * Wireframe schematic of a gamepad (the spike's ui/GamepadDiagram art, same
 * paths). `activeId` lights one or more parts, the rest dim; hovering a part
 * reports it through `onHoverPart`. Differences from the spike: the live
 * button-press polling hook is gone (the engine already reads the pad once per
 * frame; a second rAF loop here duplicated it), and the glow filter id is
 * unique per instance.
 */
const MONO = 'var(--font-hud-mono, monospace)';

const body = (s: PartLook) => ({ fill: s.fill, stroke: s.stroke, strokeWidth: s.strokeWidth });

/** One hoverable part; `children` receives its current look. Module-level so hover does not remount it (the transition needs the same node). */
function Part({
  id,
  active,
  onHover,
  children,
}: {
  id: GamepadPartId;
  active: ActivePart;
  onHover?: (id: GamepadPartId | null) => void;
  children: (s: PartLook) => ReactNode;
}) {
  const s = partLook(id, active);
  return (
    <g
      onMouseEnter={() => onHover?.(id)}
      onMouseLeave={() => onHover?.(null)}
      style={{ cursor: 'pointer', opacity: s.opacity, transition: 'opacity 180ms ease, filter 180ms ease', filter: s.filter }}
    >
      {children(s)}
    </g>
  );
}

export function GamepadDiagram({
  activeId = null,
  onHoverPart,
  style,
}: {
  activeId?: ActivePart;
  onHoverPart?: (id: GamepadPartId | null) => void;
  style?: CSSProperties;
}) {
  const glowId = `${useId().replace(/[^a-zA-Z0-9]/g, '')}-glow`;

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', ...style }}>
      <svg viewBox="0 0 441 383" style={{ width: '100%', height: '100%', maxHeight: '420px', userSelect: 'none' }} fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id={glowId} x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur" />
            <feFlood floodColor="oklch(0.9 0.06 220)" floodOpacity="0.15" />
            <feComposite in2="blur" operator="in" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Chassis */}
        <g style={{ pointerEvents: 'none' }} filter={`url(#${glowId})`}>
          <path
            d="M220.5 294.5C220.5 294.5 195 294.5 150 294.5C105 294.5 81.5 378.5 49.5 378.5C17.5 378.5 4 363.9 4 317.5C4 271.1 43.5 165.5 55 137.5C66.5 109.5 95.5 92.0001 128 92.0001C154 92.0001 200.5 92.0001 220.5 92.0001"
            stroke="var(--hud-arc)"
            strokeWidth="1.5"
            fill="var(--hud-glass-panel)"
          />
          <path
            d="M220 294.5C220 294.5 245.5 294.5 290.5 294.5C335.5 294.5 359 378.5 391 378.5C423 378.5 436.5 363.9 436.5 317.5C436.5 271.1 397 165.5 385.5 137.5C374 109.5 345 92.0001 312.5 92.0001C286.5 92.0001 240 92.0001 220 92.0001"
            stroke="var(--hud-arc)"
            strokeWidth="1.5"
            fill="var(--hud-glass-panel)"
          />
          <line x1="27.5" y1="214.5" x2="126" y2="302.5" stroke="var(--hud-arc-dim)" strokeWidth="1" strokeDasharray="4" />
          <line x1="315" y1="214.5" x2="413.5" y2="302.5" stroke="var(--hud-arc-dim)" strokeWidth="1" strokeDasharray="4" />
        </g>

        {/* L2 / R2 triggers */}
        <Part active={activeId} onHover={onHoverPart} id="l2">
          {(s) => (
            <>
              <path
                d="m152.5,52.97c0,4.62 -3.36,8.36 -7.5,8.36l-13,0c-4.14,0 -7.5,-3.74 -7.5,-8.36l0,-22.86c0,-8.62 6.27,-15.61 14,-15.61c7.73,0 14,6.99 14,15.61l0,22.86z"
                {...body(s)}
              />
              <text x="138.5" y="42" textAnchor="middle" fill={s.textColor} fontSize="11" fontWeight={s.fontWeight} fontFamily={MONO}>L2</text>
            </>
          )}
        </Part>
        <Part active={activeId} onHover={onHoverPart} id="r2">
          {(s) => (
            <>
              <path
                d="m316.83,53.44c0,4.64 -3.44,8.39 -7.68,8.39l-13.31,0c-4.24,0 -7.68,-3.76 -7.68,-8.39l0,-22.94c0,-8.65 6.42,-15.67 14.33,-15.67c7.92,0 14.33,7.01 14.33,15.67l0,22.94z"
                {...body(s)}
              />
              <text x="302.5" y="42" textAnchor="middle" fill={s.textColor} fontSize="11" fontWeight={s.fontWeight} fontFamily={MONO}>R2</text>
            </>
          )}
        </Part>

        {/* L1 / R1 bumpers */}
        <Part active={activeId} onHover={onHoverPart} id="l1">
          {(s) => (
            <>
              <rect x="116.83" y="66.83" width="43.33" height="17" rx="6.5" {...body(s)} />
              <text x="138.5" y="79" textAnchor="middle" fill={s.textColor} fontSize="10" fontWeight={s.fontWeight} fontFamily={MONO}>L1</text>
            </>
          )}
        </Part>
        <Part active={activeId} onHover={onHoverPart} id="r1">
          {(s) => (
            <>
              <rect x="281.33" y="67" width="42.67" height="17" rx="6.5" {...body(s)} />
              <text x="302.5" y="79" textAnchor="middle" fill={s.textColor} fontSize="10" fontWeight={s.fontWeight} fontFamily={MONO}>R1</text>
            </>
          )}
        </Part>

        {/* D-pad */}
        <Part active={activeId} onHover={onHoverPart} id="dpad">
          {(s) => (
            <>
              <circle cx="166" cy="238" r="37.5" {...body(s)} />
              <rect x="159" y="211" width="14" height="20" fill="var(--hud-arc)" opacity="0.75" />
              <rect x="159" y="244" width="14" height="20" fill="var(--hud-arc)" opacity="0.75" />
              <rect x="142" y="228" width="14" height="20" transform="rotate(-90 149 238)" fill="var(--hud-arc)" opacity="0.75" />
              <rect x="176" y="228" width="14" height="20" transform="rotate(-90 183 238)" fill="var(--hud-arc)" opacity="0.75" />
              <rect x="159" y="228" width="14" height="19" fill="var(--hud-arc)" opacity="0.75" />
            </>
          )}
        </Part>

        {/* Face buttons: △ top, □ left, ◯ right, ✕ bottom */}
        <Part active={activeId} onHover={onHoverPart} id="face">
          {(s) => (
            <>
              <circle cx="329" cy="160" r="37.5" {...body(s)} />
              {(
                [
                  [329, 140, 144, '△'],
                  [310, 162, 166, '□'],
                  [348, 161, 165, '◯'],
                  [330, 181, 185, '✕'],
                ] as const
              ).map(([x, cy, ty, glyph]) => (
                <g key={glyph}>
                  <circle cx={x} cy={cy} r="13" fill="transparent" stroke="var(--hud-arc-dim)" />
                  <text x={x} y={ty} textAnchor="middle" fill={s.textColor} fontSize="11" fontWeight="bold" fontFamily={MONO}>{glyph}</text>
                </g>
              ))}
            </>
          )}
        </Part>

        {/* Sticks (with L3 / R3 click) */}
        <Part active={activeId} onHover={onHoverPart} id="lstick">
          {(s) => (
            <>
              <circle cx="113" cy="160" r="37.5" {...body(s)} />
              <circle cx="113" cy="160" r="24" fill="transparent" stroke="var(--hud-arc)" strokeWidth="2.5" />
              <circle cx="113" cy="160" r="16" fill="none" stroke="var(--hud-arc-dim)" strokeWidth="1" />
              <text x="113" y="164" textAnchor="middle" fill={s.textColor} fontSize="10" fontFamily={MONO}>L / L3</text>
            </>
          )}
        </Part>
        <Part active={activeId} onHover={onHoverPart} id="rstick">
          {(s) => (
            <>
              <circle cx="278" cy="238" r="37.5" {...body(s)} />
              <circle cx="278" cy="238" r="24" fill="transparent" stroke="var(--hud-arc)" strokeWidth="2.5" />
              <circle cx="278" cy="238" r="16" fill="none" stroke="var(--hud-arc-dim)" strokeWidth="1" />
              <text x="278" y="242" textAnchor="middle" fill={s.textColor} fontSize="10" fontFamily={MONO}>R / R3</text>
            </>
          )}
        </Part>

        {/* Touchpad */}
        <Part active={activeId} onHover={onHoverPart} id="touchpad">
          {(s) => (
            <>
              <rect x="175" y="95" width="91" height="50" rx="6" {...body(s)} />
              <line x1="185" y1="120" x2="256" y2="120" stroke="var(--hud-arc-dim)" strokeWidth="1" strokeDasharray="2" />
              <text x="220.5" y="124" textAnchor="middle" fill={s.textColor} fontSize="10" fontFamily={MONO}>TOUCHPAD</text>
            </>
          )}
        </Part>

        {/* Select / Start */}
        <Part active={activeId} onHover={onHoverPart} id="select">
          {(s) => (
            <>
              <circle cx="188" cy="162" r="12" {...body(s)} />
              <g style={{ pointerEvents: 'none' }} stroke="var(--hud-arc)">
                <rect x="183" y="157" width="8" height="10" rx="1" fill="none" strokeWidth="1.4" />
                <line x1="185" y1="155" x2="191" y2="155" strokeWidth="1.2" />
              </g>
            </>
          )}
        </Part>
        <Part active={activeId} onHover={onHoverPart} id="start">
          {(s) => (
            <>
              <circle cx="253" cy="162" r="12" {...body(s)} />
              <g style={{ pointerEvents: 'none' }} stroke="var(--hud-arc)">
                <line x1="248" y1="159" x2="258" y2="159" strokeWidth="1.5" />
                <line x1="248" y1="162" x2="258" y2="162" strokeWidth="1.5" />
                <line x1="248" y1="165" x2="258" y2="165" strokeWidth="1.5" />
              </g>
            </>
          )}
        </Part>
      </svg>
    </div>
  );
}
