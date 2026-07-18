import { useState, useEffect } from 'react';
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

const textShadowStyle = { textShadow: 'var(--ow-text-shadow-ambient)' } as const;

/**
 * Thin shell that replaces the old TopTaskbar bar: three independently
 * positioned pieces floating over the 3D scene (ambient status, hero search,
 * Lens trigger) plus the Lens filter sheet itself. No shared background box.
 */
export function TopBar() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const objectCount = useStore((s) => s.objectCount);
  const dataTimestamp = useStore((s) => s.dataTimestamp);
  const simTimeMs = useStore((s) => s.simTimeMs);
  const visibilityMode = useStore((s) => s.visibilityMode);

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
          position: 'absolute',
          top: 16,
          left: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <span
          style={{
            ...textShadowStyle,
            fontFamily: 'var(--ow-font-display)',
            fontSize: 13,
            letterSpacing: '0.25em',
            color: 'var(--ow-text-mid)',
          }}
        >
          orbitwatch
        </span>
        <span
          style={{
            ...textShadowStyle,
            fontFamily: 'var(--ow-font-mono)',
            fontSize: 12,
            color: 'var(--ow-text-hi)',
          }}
        >
          {utc}
        </span>
        <span style={{ ...textShadowStyle, fontSize: 11, color: 'var(--ow-text-lo)' }}>
          Tracking {objectCount.toLocaleString()}
        </span>
        <span style={{ ...textShadowStyle, fontSize: 10, color: 'var(--ow-text-faint)' }}>
          {freshness}
        </span>
        <span style={{ ...textShadowStyle, fontSize: 11, color: 'var(--ow-text-lo)' }}>
          {perspectiveLabel(visibilityMode)}
        </span>
      </div>

      <div
        style={{
          position: 'absolute',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 440,
          zIndex: 130,
        }}
      >
        <SearchBar />
      </div>

      <button
        type="button"
        className="ow-pill"
        data-on={lensOpen || narrowedCount > 0 ? 'true' : 'false'}
        onClick={() => setLensOpen((v) => !v)}
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          zIndex: 120,
          pointerEvents: 'auto',
        }}
      >
        ⚙ Lens
        {narrowedCount > 0 && (
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
            {narrowedCount}
          </span>
        )}
      </button>

      <LensSheet open={lensOpen} onClose={() => setLensOpen(false)} />
    </>
  );
}
