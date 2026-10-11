import { useStore } from '../../../store/useStore';
import { DOCK_H, DOCK_ITEM_GAP, DOCK_PAD_X } from '../layout';
import { DockIconButton } from './DockIconButton';
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
        boxShadow: 'var(--hud-inner-glow)',
        pointerEvents: 'auto',
      }}
    >
      <div style={{ flex: '1 1 0', display: 'flex', justifyContent: 'flex-start', height: '100%' }}>
        <ModeControls />
      </div>
      <div style={{ flex: '1 1 0', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', height: '100%', gap: DOCK_ITEM_GAP }}>
        <LensLocationControls />
        <DockIconButton glyph="?" label="Cockpit controls help" onClick={() => useStore.getState().toggleControlsSheet()} />
      </div>
    </div>
  );
}
