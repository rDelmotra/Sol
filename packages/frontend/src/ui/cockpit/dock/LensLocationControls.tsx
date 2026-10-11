import { useEffect, useRef, useState } from 'react';
import type { SkyLens } from '../../../store/types';
import { useStore } from '../../../store/useStore';
import { latLonStr, lensDisabled } from './dock-modes';
import { DockSeg } from './DockSeg';
import { DOCK_BLUE, DOCK_GROUP, DOCK_LABEL } from './dock-styles';
import { LocationPopover } from './LocationPopover';

const LENSES: { lens: SkyLens; label: string }[] = [
  { lens: 'all', label: 'ALL' },
  { lens: 'horizon', label: 'HORIZON' },
  { lens: 'radio', label: 'RADIO ≥10°' },
];

/**
 * Dock right: SKY LENS ALL · HORIZON · RADIO, the observer's coordinates and
 * the location pin. The pin toggles LocationPopover; Esc (before the cockpit's
 * own Esc handling) or a press outside closes it.
 */
export function LensLocationControls() {
  const vantage = useStore((s) => s.vantage);
  const skyLens = useStore((s) => s.skyLens);
  const location = useStore((s) => s.observerLocation);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture phase on window runs before the cockpit's bubble listener, so
      // one Esc closes only the popover.
      e.stopPropagation();
      setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ ...DOCK_GROUP, position: 'relative' }}>
      <span style={DOCK_LABEL}>SKY LENS</span>
      {LENSES.map(({ lens, label }) => (
        <DockSeg
          key={lens}
          label={label}
          active={skyLens === lens}
          disabled={lensDisabled(lens, location !== null, vantage)}
          onClick={() => useStore.getState().setSkyLens(lens)}
        />
      ))}

      <span style={{ width: 1, height: 14, background: 'var(--hud-glass-edge)', margin: '0 10px' }} />

      {location && (
        <span style={{ fontSize: 9, letterSpacing: '0.16em', color: DOCK_BLUE, marginRight: 8, whiteSpace: 'nowrap' }}>
          {latLonStr(location.lat, location.lon)}
        </span>
      )}
      <button
        type="button"
        aria-label="Location"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ appearance: 'none', background: 'none', border: 'none', padding: 2, cursor: 'pointer', lineHeight: 0 }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={location ? DOCK_BLUE : 'var(--hud-text-dim)'} strokeWidth="1.6">
          <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
          <circle cx="12" cy="10" r="2.2" />
        </svg>
      </button>

      {open && <LocationPopover />}
    </div>
  );
}
