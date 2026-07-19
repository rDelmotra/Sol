import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useStore } from '../store/useStore';
import type { VisibilityMode } from '../store/useStore';
import { SearchBar } from './SearchBar';
import { LensSheet } from './Lens/LensSheet';

function formatUTC(date: Date): string {
  return date.toISOString().slice(11, 19) + ' UTC';
}

function formatFreshness(timestamp: number | null): string {
  if (timestamp === null) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Data: just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Data: ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `Data: ${hours} hr ago`;
}

function perspectiveLabel(mode: VisibilityMode): string {
  return mode === 'all' ? 'Global' : mode === 'radio' ? 'Radio Pass' : 'Sky Dome';
}

/** Any-value-false check across a facet's on/off record — used to know whether
 *  that facet group is narrowing the catalog (i.e. not every key is enabled). */
function groupNarrowed(rec: Record<string, boolean>): boolean {
  return Object.values(rec).some((v) => !v);
}

/**
 * The bridge taskbar — a real in-flow bar at the top of the shell (no longer
 * floating fragments). HUD status left, hero Search/Ask center, Lens right.
 * Dims with the rest of the HUD while the time scrubber is modal.
 */
export function TopBar() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const objectCount = useStore((s) => s.objectCount);
  const dataTimestamp = useStore((s) => s.dataTimestamp);
  const simTimeMs = useStore((s) => s.simTimeMs);
  const visibilityMode = useStore((s) => s.visibilityMode);
  const scrubberMode = useStore((s) => s.scrubberMode);

  const typeFilters = useStore((s) => s.typeFilters);
  const statusFilters = useStore((s) => s.statusFilters);
  const sectorFilters = useStore((s) => s.sectorFilters);
  const purposeFilters = useStore((s) => s.purposeFilters);
  const regimeFilters = useStore((s) => s.regimeFilters);
  const countryFilter = useStore((s) => s.countryFilter);

  const [freshness, setFreshness] = useState(() => formatFreshness(dataTimestamp));
  useEffect(() => {
    setFreshness(formatFreshness(dataTimestamp));
    if (dataTimestamp === null) return;
    const id = setInterval(() => setFreshness(formatFreshness(dataTimestamp)), 60_000);
    return () => clearInterval(id);
  }, [dataTimestamp]);

  const [lensOpen, setLensOpen] = useState(false);

  const utc = formatUTC(new Date(simTimeMs));
  const narrowedCount =
    [typeFilters, statusFilters, sectorFilters, purposeFilters, regimeFilters].filter(groupNarrowed)
      .length + (countryFilter.mode === 'only' ? 1 : 0);

  if (loadingPhase !== 'ready') return null;

  return (
    <>
      <div
        style={{
          ...barStyle,
          opacity: scrubberMode ? 0.25 : 1,
          pointerEvents: scrubberMode ? 'none' : 'auto',
        }}
      >
        {/* Left — the HUD cluster */}
        <div style={hudClusterStyle}>
          <span style={wordmarkStyle}>orbitwatch</span>
          <span style={utcStyle}>{utc}</span>
          <span style={hudDimStyle}>{objectCount.toLocaleString()} tracked</span>
          {freshness && <span style={hudFaintStyle}>{freshness}</span>}
          <span style={hudDimStyle}>{perspectiveLabel(visibilityMode)}</span>
        </div>

        {/* Center — hero search / Ask */}
        <div style={searchSlotStyle}>
          <SearchBar />
        </div>

        {/* Right — the Lens */}
        <div style={rightSlotStyle}>
          <button
            type="button"
            className="ow-pill"
            data-on={lensOpen || narrowedCount > 0 ? 'true' : 'false'}
            onClick={() => setLensOpen((v) => !v)}
          >
            ⚙ Lens
            {narrowedCount > 0 && <span style={lensCountStyle}>{narrowedCount}</span>}
          </button>
        </div>
      </div>

      <LensSheet open={lensOpen} onClose={() => setLensOpen(false)} />
    </>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const barStyle: CSSProperties = {
  position: 'relative',
  zIndex: 120,
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  height: 52,
  padding: '0 16px',
  flexShrink: 0,
  background: 'var(--ow-surface-1)',
  backdropFilter: 'blur(var(--ow-blur-1))',
  WebkitBackdropFilter: 'blur(var(--ow-blur-1))',
  borderBottom: '1px solid var(--ow-stroke)',
  fontFamily: 'var(--ow-font-display)',
  transition: 'opacity var(--ow-dur-2) var(--ow-ease)',
};

const hudClusterStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 14,
  minWidth: 0,
  flex: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
};

const wordmarkStyle: CSSProperties = {
  fontSize: 12,
  letterSpacing: '0.25em',
  color: 'var(--ow-text-mid)',
};

const utcStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-mono)',
  fontSize: 12,
  color: 'var(--ow-text-hi)',
};

const hudDimStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--ow-text-lo)',
};

const hudFaintStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--ow-text-faint)',
};

const searchSlotStyle: CSSProperties = {
  width: 'min(440px, 40vw)',
  flexShrink: 0,
};

/** Mirrors the left cluster's flex so the search stays visually centered. */
const rightSlotStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  justifyContent: 'flex-end',
};

const lensCountStyle: CSSProperties = {
  background: 'var(--ow-perceptor-soft)',
  color: 'var(--ow-perceptor)',
  borderRadius: 'var(--ow-r-pill)',
  padding: '1px 7px',
  fontSize: 10,
  fontFamily: 'var(--ow-font-mono)',
};
