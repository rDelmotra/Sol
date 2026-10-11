import { useStore } from '../../store/useStore';
import { DOCK_H, DOCK_PAD_X } from './layout';
import { LensLocationControls } from './LensLocationControls';
import { ModeControls } from './ModeControls';

/**
 * Bottom dock: one 40 px glass bar flush to the bottom edge. Left MODE, right
 * SKY LENS · location pin · `?` (controls sheet). Shown once loading is done,
 * hidden under the controls sheet. No animation. Everything floating at the
 * bottom offsets from DOCK_H (layout.ts).
 */
export function Dock() {
  const ready = useStore((s) => s.loadingPhase === 'ready');
  const sheetOpen = useStore((s) => s.controlsSheetOpen);
  if (!ready || sheetOpen) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: DOCK_H,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `0 ${DOCK_PAD_X}px`,
        background: 'var(--hud-glass)',
        borderTop: '1px solid var(--hud-glass-edge)',
        backdropFilter: 'blur(14px) saturate(120%)',
        WebkitBackdropFilter: 'blur(14px) saturate(120%)',
        boxShadow: '0 0 40px oklch(0.85 0.14 220 / 0.06) inset',
        pointerEvents: 'auto',
      }}
    >
      <div style={{ flex: '1 1 0', display: 'flex', justifyContent: 'flex-start', height: '100%' }}>
        <ModeControls />
      </div>
      <div style={{ flex: '1 1 0', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', height: '100%', gap: 14 }}>
        <LensLocationControls />
        <button
          type="button"
          onClick={() => useStore.getState().toggleControlsSheet()}
          aria-label="Cockpit controls help"
          style={{
            appearance: 'none',
            background: 'none',
            border: '1px solid var(--hud-arc-dim)',
            borderRadius: 9999,
            width: 20,
            height: 20,
            padding: 0,
            color: 'var(--hud-text-dim)',
            fontFamily: 'var(--font-hud-mono)',
            fontSize: 11,
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ?
        </button>
      </div>
    </div>
  );
}
