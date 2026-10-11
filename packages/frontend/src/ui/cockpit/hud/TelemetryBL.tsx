import { useStore } from '../../../store/useStore';
import { HUD_CORNER_INSET, STATUS_BOTTOM } from '../layout';

const DOT: React.CSSProperties = {
  marginRight: 8,
  display: 'inline-block',
  height: 6,
  width: 6,
  borderRadius: 9999,
  verticalAlign: 'middle',
};

/** Bottom-left status: camera mode ("NAV FREE") and the Ask state ("AI IDLE"). */
export function TelemetryBL() {
  const cameraMode = useStore((s) => s.cameraMode);
  const status = useStore((s) => s.analyticAnswer?.status ?? null);
  const aiLabel = status ? status.toUpperCase() : 'IDLE';
  const aiColor = status === 'error' || status === 'compiling' ? 'var(--hud-warn)' : 'var(--hud-good)';

  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        bottom: STATUS_BOTTOM,
        left: HUD_CORNER_INSET,
        fontSize: 10,
        lineHeight: 1.625,
        fontFamily: 'var(--font-hud-mono)',
        color: 'var(--hud-text-dim)',
      }}
    >
      <div>
        <span style={{ ...DOT, background: 'var(--hud-good)' }} />
        NAV {cameraMode.toUpperCase()}
      </div>
      <div>
        <span style={{ ...DOT, background: aiColor }} />
        AI {aiLabel}
      </div>
    </div>
  );
}
