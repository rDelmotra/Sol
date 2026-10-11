import { useEffect, useRef } from 'react';
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
 * the location pin. The pin toggles LocationPopover (open state is in the store);
 * a press outside closes it, Esc closes it via keys.ts.
 */
export function LensLocationControls() {
  const vantage = useStore((s) => s.vantage);
  const skyLens = useStore((s) => s.skyLens);
  const location = useStore((s) => s.observerLocation);
  const open = useStore((s) => s.locationPopoverOpen);
  const setOpen = useStore((s) => s.setLocationPopoverOpen);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, setOpen]);

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
        onClick={() => setOpen(!open)}
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
