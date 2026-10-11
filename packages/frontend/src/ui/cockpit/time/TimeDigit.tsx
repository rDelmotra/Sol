import type { TimeField } from '../../../time/time-fields';

/**
 * One digit group of the clock. Closed: inert text. Open: click selects the
 * field, wheel steps it ±1 (wheel up = later). The active group gets an amber
 * tint and an underline that scales in, so moving the field reads as a marker
 * travelling between groups.
 */
export function TimeDigit({
  field, value, open, active, onSelect, onStep,
}: {
  field: TimeField;
  value: string;
  open: boolean;
  active: boolean;
  onSelect: (f: TimeField) => void;
  onStep: (f: TimeField, dir: number) => void;
}) {
  return (
    <span
      onClick={open ? (e) => { e.stopPropagation(); onSelect(field); } : undefined}
      onWheel={open ? (e) => { e.stopPropagation(); onSelect(field); onStep(field, e.deltaY < 0 ? 1 : -1); } : undefined}
      style={{
        position: 'relative',
        padding: open ? '0 3px' : 0,
        borderRadius: 3,
        cursor: open ? 'ns-resize' : 'inherit',
        pointerEvents: open ? 'auto' : 'none',
        color: active ? 'var(--hud-text)' : open ? 'var(--hud-text-dim)' : 'inherit',
        background: active ? 'oklch(0.82 0.14 55 / 0.16)' : 'transparent',
        transition: 'color 160ms ease, background 160ms ease',
      }}
    >
      {value}
      <span
        style={{
          position: 'absolute', left: 2, right: 2, bottom: -2, height: 1.5,
          background: 'var(--hud-warn)',
          transform: `scaleX(${active ? 1 : 0})`,
          transformOrigin: 'center',
          transition: 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      />
    </span>
  );
}
