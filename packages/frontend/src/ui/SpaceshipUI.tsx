import { useState } from 'react';
import { useStore } from '../store/useStore';

// --- Utility & Math Functions ---
function polarToCartesian(cx: number, cy: number, r: number, angleInDegrees: number) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: cx + r * Math.cos(angleInRadians),
    y: cy + r * Math.sin(angleInRadians),
  };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = Math.abs(endAngle - startAngle) <= 180 ? '0' : '1';
  return ['M', start.x, start.y, 'A', r, r, 0, largeArcFlag, 0, end.x, end.y].join(' ');
}

// Draws the appendage background locking perfectly to whatever arc angles we provide
function getAppendageFill(leftX: number, topAngle: number, bottomAngle: number, cx: number, cy: number, r: number) {
  const tr = polarToCartesian(cx, cy, r, topAngle);
  const br = polarToCartesian(cx, cy, r, bottomAngle);
  return [
    'M', leftX, tr.y,
    'L', tr.x, tr.y,
    'A', r, r, 0, 0, 0, br.x, br.y,
    'L', leftX, br.y,
    'Z'
  ].join(' ');
}

function getAppendageBorder(leftX: number, topAngle: number, bottomAngle: number, cx: number, cy: number, r: number) {
  const tr = polarToCartesian(cx, cy, r, topAngle);
  const br = polarToCartesian(cx, cy, r, bottomAngle);
  return `M ${tr.x} ${tr.y} L ${leftX} ${tr.y} L ${leftX} ${br.y} L ${br.x} ${br.y}`;
}

export function SpaceshipUI() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const simRate = useStore((s) => s.simRate);
  const cameraMode = useStore((s) => s.cameraMode);

  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const [hoveredLeft, setHoveredLeft] = useState(false);
  const [hoveredRight, setHoveredRight] = useState(false);

  if (loadingPhase !== 'ready') return null;

  // --- Speed Logic ---
  const absRate = Math.abs(simRate);
  let speedFraction = 0.2;
  if (cameraMode === 'flying' || cameraMode === 'returning') {
    speedFraction = 0.9;
  } else if (absRate > 1) {
    speedFraction = Math.min(1.0, 0.2 + Math.log10(absRate) * 0.3);
  }
  const speedArcThickness = 2 + speedFraction * 6;
  const speedArcOpacity = 0.3 + speedFraction * 0.7;

  // --- Theme Colors ---
  const offWhite = 'rgba(235, 240, 255, 0.5)';
  const hoverWhite = 'rgba(255, 255, 255, 1)';
  const speedColor = 'rgba(180, 220, 255, 0.9)';

  const panelFill = 'rgba(8, 14, 22, 0.7)';
  const panelBorder = 'rgba(255, 255, 255, 0.15)';

  // --- Geometry (Restored to your exact specs) ---
  const cy = 1000;
  const arcRadius = 860;

  // Centers offset by 20%
  const leftCx = 1672;
  const rightCx = 1328;

  // Main Arc Sweeps (Restored 52° sweep for the 70% increased length)
  const leftArcTop = 296;
  const leftArcBottom = 244;

  const rightArcTop = 64;
  const rightArcBottom = 116;

  // Appendage math: dynamically split the left arc's exact length in half to anchor the panels
  const panelGap = 4; // 4 degrees of separation between panels
  const midPoint = (leftArcTop + leftArcBottom) / 2; // 270 degrees

  const topPanelTopAngle = leftArcTop; // 296
  const topPanelBottomAngle = midPoint + (panelGap / 2); // 272
  const bottomPanelTopAngle = midPoint - (panelGap / 2); // 268
  const bottomPanelBottomAngle = leftArcBottom; // 244

  const panelLeftX = 400; // Defines how far left the panels stretch

  // Dynamic Y coordinates for perfect HTML container fitting
  const topPanelTopY = polarToCartesian(leftCx, cy, arcRadius, topPanelTopAngle).y;
  const topPanelBottomY = polarToCartesian(leftCx, cy, arcRadius, topPanelBottomAngle).y;
  const topPanelHeight = topPanelBottomY - topPanelTopY;

  const bottomPanelTopY = polarToCartesian(leftCx, cy, arcRadius, bottomPanelTopAngle).y;
  const bottomPanelBottomY = polarToCartesian(leftCx, cy, arcRadius, bottomPanelBottomAngle).y;
  const bottomPanelHeight = bottomPanelBottomY - bottomPanelTopY;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 10,
        fontFamily: "'Space Mono', 'Roboto Mono', monospace",
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: '100vw',
          height: '100vh',
          transform: 'translate(-50%, -50%)',
          minWidth: '1200px',
        }}
      >
        <svg viewBox="0 0 3000 2000" style={{ width: '100%', height: '100%' }} preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="soft-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* ── LEFT APPENDAGE PANELS ── */}
          <g
            style={{
              transform: leftPanelOpen ? 'translateX(0px)' : 'translateX(80px)',
              opacity: leftPanelOpen ? 1 : 0,
              pointerEvents: leftPanelOpen ? 'auto' : 'none',
              transition: 'all 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            {/* TOP PANEL */}
            <g>
              <path
                d={getAppendageFill(panelLeftX, topPanelTopAngle, topPanelBottomAngle, leftCx, cy, arcRadius)}
                fill={panelFill}
              />
              <path
                d={getAppendageBorder(panelLeftX, topPanelTopAngle, topPanelBottomAngle, leftCx, cy, arcRadius)}
                fill="none"
                stroke={panelBorder}
                strokeWidth="2"
              />
              <foreignObject x={panelLeftX} y={topPanelTopY} width={450} height={topPanelHeight}>
                <div style={{ width: '100%', height: '100%', padding: '32px', boxSizing: 'border-box', color: 'rgba(255,255,255,0.85)', overflowY: 'auto' }}>
                  <div style={{ fontSize: '13px', letterSpacing: '3px', opacity: 0.5, marginBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px' }}>
                    01 // CORE TELEMETRY
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', fontSize: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ opacity: 0.6 }}>HULL INTEGRITY</span>
                      <span style={{ color: speedColor }}>100%</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ opacity: 0.6 }}>THERMAL LOAD</span>
                      <span>NOMINAL</span>
                    </div>
                  </div>
                </div>
              </foreignObject>
            </g>

            {/* BOTTOM PANEL */}
            <g>
              <path
                d={getAppendageFill(panelLeftX, bottomPanelTopAngle, bottomPanelBottomAngle, leftCx, cy, arcRadius)}
                fill={panelFill}
              />
              <path
                d={getAppendageBorder(panelLeftX, bottomPanelTopAngle, bottomPanelBottomAngle, leftCx, cy, arcRadius)}
                fill="none"
                stroke={panelBorder}
                strokeWidth="2"
              />
              <foreignObject x={panelLeftX} y={bottomPanelTopY} width={450} height={bottomPanelHeight}>
                <div style={{ width: '100%', height: '100%', padding: '32px', boxSizing: 'border-box', color: 'rgba(255,255,255,0.85)', overflowY: 'auto' }}>
                  <div style={{ fontSize: '13px', letterSpacing: '3px', opacity: 0.5, marginBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px' }}>
                    02 // SUB-SYSTEM LOG
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12px', opacity: 0.6, lineHeight: 1.6 }}>
                    <div>&gt; Syncing orbital mechanics...</div>
                    <div>&gt; Establishing vector lock...</div>
                    <div style={{ opacity: 0.3, marginTop: '8px' }}>_</div>
                  </div>
                </div>
              </foreignObject>
            </g>
          </g>

          {/* ── LEFT ARC GROUP ── */}
          <g
            style={{ pointerEvents: 'auto', cursor: 'pointer', transition: 'all 0.4s ease' }}
            onMouseEnter={() => setHoveredLeft(true)}
            onMouseLeave={() => setHoveredLeft(false)}
            onClick={() => setLeftPanelOpen(!leftPanelOpen)}
          >
            <path
              d={describeArc(leftCx, cy, arcRadius, leftArcBottom - 10, leftArcTop + 10)}
              fill="none"
              stroke="transparent"
              strokeWidth="80"
            />
            {/* Main Visual Arc */}
            <path
              d={describeArc(leftCx, cy, arcRadius, leftArcBottom, leftArcTop)}
              fill="none"
              stroke={hoveredLeft ? hoverWhite : offWhite}
              strokeWidth="3"
              strokeLinecap="round"
              filter={hoveredLeft ? 'url(#soft-glow)' : 'none'}
              style={{ transition: 'all 0.3s ease' }}
            />
            {/* Hover Target Ring */}
            <path
              d={describeArc(leftCx, cy, arcRadius - 20, leftArcBottom + 2, leftArcTop - 2)}
              fill="none"
              stroke={hoverWhite}
              strokeWidth="1.5"
              strokeDasharray="6 24"
              opacity={hoveredLeft ? 0.7 : 0}
              style={{ transition: 'opacity 0.4s ease' }}
            />
          </g>

          {/* ── RIGHT ARC GROUP ── */}
          <g
            style={{ pointerEvents: 'auto', transition: 'all 0.4s ease' }}
            onMouseEnter={() => setHoveredRight(true)}
            onMouseLeave={() => setHoveredRight(false)}
          >
            <path
              d={describeArc(rightCx, cy, arcRadius, rightArcTop - 10, rightArcBottom + 10)}
              fill="none"
              stroke="transparent"
              strokeWidth="80"
            />
            <path
              d={describeArc(rightCx, cy, arcRadius, rightArcTop, rightArcBottom)}
              fill="none"
              stroke={hoveredRight ? hoverWhite : offWhite}
              strokeWidth="3"
              strokeLinecap="round"
              filter={hoveredRight ? 'url(#soft-glow)' : 'none'}
              style={{ transition: 'all 0.3s ease' }}
            />
            <path
              d={describeArc(rightCx, cy, arcRadius + 20, rightArcTop + 2, rightArcBottom - 2)}
              fill="none"
              stroke={hoverWhite}
              strokeWidth="1.5"
              strokeDasharray="6 24"
              opacity={hoveredRight ? 0.7 : 0}
              style={{ transition: 'opacity 0.4s ease' }}
            />

            {/* ── PARALLEL SPEED ARC ── */}
            <path
              d={describeArc(rightCx, cy, arcRadius - 28, rightArcTop + 3, rightArcBottom - 3)}
              fill="none"
              stroke={speedColor}
              strokeWidth={speedArcThickness}
              strokeOpacity={speedArcOpacity}
              strokeLinecap="round"
              filter="url(#soft-glow)"
              style={{ transition: 'stroke-width 0.5s ease-out, stroke-opacity 0.5s ease' }}
            />
          </g>
        </svg>
      </div>
    </div>
  );
}