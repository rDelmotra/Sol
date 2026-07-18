import { useState, useRef, useEffect, ReactNode } from 'react';

interface DropdownMenuProps {
  label: string;
  activeCount?: number;
  children: ReactNode;
  width?: number;
}

export function DropdownMenu({ label, activeCount = 0, children, width = 240 }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="ow-pill"
        data-on={open || activeCount > 0 ? 'true' : 'false'}
        onClick={() => setOpen(!open)}
      >
        {label}
        {activeCount > 0 && (
          <span
            style={{
              background: 'var(--ow-perceptor-soft)',
              color: 'var(--ow-perceptor)',
              borderRadius: 'var(--ow-r-pill)',
              padding: '1px 7px',
              fontSize: 10,
              fontFamily: 'var(--ow-font-mono)',
            }}
          >
            {activeCount}
          </span>
        )}
        <span
          style={{
            fontSize: 8,
            opacity: 0.6,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--ow-dur-2) var(--ow-ease)',
          }}
        >
          ▼
        </span>
      </button>

      {open && (
        <div
          className="ow-glass ow-scroll"
          data-elev="3"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width,
            borderRadius: 'var(--ow-r-lg)',
            padding: 12,
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 'min(600px, 60vh)',
            overflowY: 'auto',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
