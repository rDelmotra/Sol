import { useStore } from '../store/useStore';

export function Tooltip() {
  const name = useStore((s) => s.hoveredName);
  const x = useStore((s) => s.hoverScreenX);
  const y = useStore((s) => s.hoverScreenY);

  if (!name) return null;

  return (
    <div
      className="ow-glass"
      data-elev="3"
      style={{
        position: 'fixed',
        left: x + 14,
        top: y - 10,
        padding: '4px 9px',
        borderRadius: 'var(--ow-r-sm)',
        fontFamily: 'var(--ow-font-mono)',
        fontSize: '11px',
        color: 'var(--ow-text-hi)',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        zIndex: 900,
      }}
    >
      {name}
    </div>
  );
}
