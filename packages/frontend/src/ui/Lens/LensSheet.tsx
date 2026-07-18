import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { IconButton } from '../primitives';
import { lensDividerStyle } from './shared';
import { PerspectiveSection } from './sections/PerspectiveSection';
import { RegimeSection } from './sections/RegimeSection';
import { TypeSection } from './sections/TypeSection';
import { StatusSection } from './sections/StatusSection';
import { SectorSection } from './sections/SectorSection';
import { PurposeSection } from './sections/PurposeSection';
import { CountrySection } from './sections/CountrySection';
import { ColorBySection } from './sections/ColorBySection';

const scrimStyleBase: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 150,
  background: 'var(--ow-scrim)',
  transition: 'opacity var(--ow-dur-3) var(--ow-ease)',
};

const sheetStyleBase: CSSProperties = {
  position: 'fixed',
  top: 64,
  right: 16,
  bottom: 16,
  width: 340,
  zIndex: 160,
  borderRadius: 'var(--ow-r-lg)',
  padding: 20,
  overflowY: 'auto',
  transition: 'transform var(--ow-dur-3) var(--ow-ease)',
};

const headerRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 16,
};

const titleStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-display)',
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--ow-text-hi)',
};

/**
 * Right-side frosted filter sheet — replaces the old per-facet dropdown menus.
 * Holds every filter/perspective control in one scrollable column. Self-contained:
 * each section reads its own store slice; this component only owns open/close chrome.
 */
export function LensSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  return (
    <>
      <div
        className="ow-lens-scrim"
        style={{
          ...scrimStyleBase,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
        onClick={onClose}
      />
      <div
        className="ow-glass ow-scroll ow-lens-sheet"
        data-elev="3"
        style={{
          ...sheetStyleBase,
          transform: open ? 'translateX(0)' : 'translateX(120%)',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <div style={headerRowStyle}>
          <span style={titleStyle}>Lens</span>
          <IconButton ariaLabel="Close filters" onClick={onClose}>
            ×
          </IconButton>
        </div>

        <PerspectiveSection />
        <div style={lensDividerStyle} />
        <RegimeSection />
        <div style={lensDividerStyle} />
        <TypeSection />
        <div style={lensDividerStyle} />
        <StatusSection />
        <div style={lensDividerStyle} />
        <SectorSection />
        <div style={lensDividerStyle} />
        <PurposeSection />
        <div style={lensDividerStyle} />
        <CountrySection />
        <div style={lensDividerStyle} />
        <ColorBySection />
      </div>
    </>
  );
}
