import { useMemo, useState } from 'react';
import { useStore, type ColorBy } from '../store/useStore';
import type { CatalogType } from '../data/types';
import type { OrbitalRegime, OrbitalStatus, Purpose } from '@orbitwatch/contracts';
import { displayCountry, countryFlag } from '@orbitwatch/contracts';
import type { SectorFilterKey } from '../data/metadata-types';
import { ORBITAL_STATUS_LABELS, PURPOSE_LABELS, SECTOR_LABELS } from '../data/metadata-types';
import {
  TYPE_COLORS,
  STATUS_COLORS,
  SECTOR_COLORS,
  COUNTRY_COLORS,
  FALLBACK_GREY,
  rgbToCss,
} from '../data/facet-colors';

// ── Facet group definitions ───────────────────────────────────────────────────

const TYPE_KEYS: CatalogType[] = ['satellite', 'rocket_body', 'debris', 'unknown', 'deep_space'];
const TYPE_LABELS: Record<CatalogType, string> = {
  satellite: 'Payload',
  rocket_body: 'Rocket Body',
  debris: 'Debris',
  unknown: 'Unknown',
  deep_space: 'Deep Space',
};

const STATUS_KEYS: OrbitalStatus[] = ['in_orbit', 'decayed', 'deorbited', 'beyond_earth', 'exploded', 'unknown'];
const SECTOR_KEYS: SectorFilterKey[] = ['commercial', 'government', 'military', 'civil', 'unspecified'];
const PURPOSE_KEYS: Purpose[] = [
  'communications', 'earth_observation', 'navigation', 'technology_dev',
  'space_science', 'space_observation', 'surveillance', 'meteorological', 'other',
];
const REGIME_KEYS: OrbitalRegime[] = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];
const REGIME_LABELS: Record<OrbitalRegime, string> = {
  LEO: 'LEO', MEO: 'MEO', GEO: 'GEO', HEO: 'HEO', OTHER: 'Other',
};

const COLOR_BY_OPTIONS: { key: ColorBy; label: string }[] = [
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'sector', label: 'Sector' },
  { key: 'country', label: 'Country' },
];

// ── Small presentational helpers ──────────────────────────────────────────────

function Toggle({
  on,
  onToggle,
  disabled = false,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      onClick={onToggle}
      disabled={disabled}
      style={{
        width: 32,
        height: 16,
        borderRadius: 8,
        border: 'none',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.08)',
        position: 'relative',
        flexShrink: 0,
        transition: 'background 0.15s',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 16 : 2,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: on ? '#fff' : 'rgba(255, 255, 255, 0.35)',
          transition: 'left 0.15s, background 0.15s',
        }}
      />
    </button>
  );
}

interface FacetRowData {
  key: string;
  label: string;
  on: boolean;
  visible: number;
  total: number;
  swatch?: string; // css color — present only when this group is the active color-by
  onToggle: () => void;
}

function FacetRow({ row }: { row: FacetRowData }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        opacity: row.on ? 1 : 0.4,
        transition: 'opacity 0.15s',
      }}
    >
      <Toggle on={row.on} onToggle={row.onToggle} />
      {row.swatch && (
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: row.swatch, flexShrink: 0 }} />
      )}
      <span>{row.label}</span>
      <span style={countStyle}>
        {row.visible.toLocaleString()} / {row.total.toLocaleString()}
      </span>
    </div>
  );
}

function FacetSection({ title, rows, defaultOpen = false }: { title: string; rows: FacetRowData[]; defaultOpen?: boolean }) {
  // Local open state synced via onToggle: the panel re-renders ~1Hz as counts
  // update, so a statically-controlled `open` would fight the user's collapse.
  const [openState, setOpenState] = useState(defaultOpen);
  if (rows.length === 0) return null;
  return (
    <details
      open={openState}
      onToggle={(e) => setOpenState((e.currentTarget as HTMLDetailsElement).open)}
      style={{ marginTop: 12 }}
    >
      <summary style={summaryStyle}>{title}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {rows.map((row) => <FacetRow key={row.key} row={row} />)}
      </div>
    </details>
  );
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  left: 16,
  width: 260,
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '14px 16px',
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  fontFamily: 'monospace',
  fontSize: 12,
  color: 'rgba(255, 255, 255, 0.85)',
  pointerEvents: 'auto' as const,
  transition: 'transform 0.25s ease, opacity 0.25s ease',
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'rgba(255, 255, 255, 0.35)',
  marginBottom: 8,
};

const summaryStyle: React.CSSProperties = {
  ...sectionHeaderStyle,
  marginBottom: 0,
  cursor: 'pointer',
  userSelect: 'none',
};

const countStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(255, 255, 255, 0.4)',
  marginLeft: 'auto',
  flexShrink: 0,
  paddingLeft: 8,
};

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: 'rgba(255, 255, 255, 0.08)',
  margin: '12px 0',
};

const OBSERVER_LOCATION_CACHE_KEY = 'orbitwatch:observerLocation:v1';
const OBSERVER_LOCATION_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const LOCATION_RETRY_MAX_AGE_MS = 30 * 60 * 1000;

interface ObserverLocationValue {
  lat: number;
  lon: number;
  alt: number;
}

interface ObserverLocationCacheEnvelope extends ObserverLocationValue {
  savedAt: number;
}

function geolocateOnce(options: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function toObserverLocation(position: GeolocationPosition): ObserverLocationValue {
  const altitudeMeters = position.coords.altitude;
  const altitudeKm =
    typeof altitudeMeters === 'number' && Number.isFinite(altitudeMeters)
      ? altitudeMeters / 1000
      : 0;
  return {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    alt: altitudeKm,
  };
}

function cacheObserverLocation(location: ObserverLocationValue): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    const payload: ObserverLocationCacheEnvelope = {
      ...location,
      savedAt: Date.now(),
    };
    localStorage.setItem(OBSERVER_LOCATION_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore local cache write errors.
  }
}

function clearCachedObserverLocation(): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.removeItem(OBSERVER_LOCATION_CACHE_KEY);
  } catch {
    // Ignore local cache remove errors.
  }
}

function readCachedObserverLocation(): ObserverLocationCacheEnvelope | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(OBSERVER_LOCATION_CACHE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<ObserverLocationCacheEnvelope>;
    if (
      typeof parsed.lat !== 'number'
      || typeof parsed.lon !== 'number'
      || typeof parsed.alt !== 'number'
      || typeof parsed.savedAt !== 'number'
      || !Number.isFinite(parsed.lat)
      || !Number.isFinite(parsed.lon)
      || !Number.isFinite(parsed.alt)
      || !Number.isFinite(parsed.savedAt)
    ) {
      return null;
    }

    return {
      lat: parsed.lat,
      lon: parsed.lon,
      alt: parsed.alt,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

function formatAge(ms: number): string {
  const totalMinutes = Math.max(1, Math.floor(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function getLocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case 1:
      return 'Location permission denied. Enable browser + system location permissions.';
    case 2:
      return 'Live location unavailable (CoreLocation could not resolve position). Try again in a few seconds or move to an open-sky area.';
    case 3:
      return 'Location request timed out. Try again.';
    default:
      return `Unable to retrieve location: ${err.message}`;
  }
}

export function FilterPanel() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const facet = useStore((s) => s.facetCounts);
  const visibleFacet = useStore((s) => s.visibleFacetCounts);
  const regimeCounts = useStore((s) => s.regimeCounts);
  const visibleRegCounts = useStore((s) => s.visibleRegimeCounts);
  const typeFilters = useStore((s) => s.typeFilters);
  const statusFilters = useStore((s) => s.statusFilters);
  const sectorFilters = useStore((s) => s.sectorFilters);
  const purposeFilters = useStore((s) => s.purposeFilters);
  const regimeFilters = useStore((s) => s.regimeFilters);
  const countryFilter = useStore((s) => s.countryFilter);
  const colorBy = useStore((s) => s.colorBy);
  const toggleTypeFilter = useStore((s) => s.toggleTypeFilter);
  const toggleStatusFilter = useStore((s) => s.toggleStatusFilter);
  const toggleSectorFilter = useStore((s) => s.toggleSectorFilter);
  const togglePurposeFilter = useStore((s) => s.togglePurposeFilter);
  const toggleRegime = useStore((s) => s.toggleRegimeFilter);
  const setCountryFilter = useStore((s) => s.setCountryFilter);
  const setColorBy = useStore((s) => s.setColorBy);
  const visibilityMode = useStore((s) => s.visibilityMode);
  const observerLocation = useStore((s) => s.observerLocation);
  const setVisibilityMode = useStore((s) => s.setVisibilityMode);
  const setObserverLocation = useStore((s) => s.setObserverLocation);
  const visualList = useStore((s) => s.visualList);

  const [open, setOpen] = useState(true);
  const [isLocating, setIsLocating] = useState(false);
  const [locationStatusMessage, setLocationStatusMessage] = useState<string | null>(null);
  const [countrySearch, setCountrySearch] = useState('');

  // Country rows: present operators sorted by count desc, filtered by the search box.
  const countryRows = useMemo(() => {
    const q = countrySearch.trim().toLowerCase();
    return Object.keys(facet.country)
      .filter((code) => {
        if (!q) return true;
        return code.toLowerCase().includes(q) || displayCountry(code).toLowerCase().includes(q);
      })
      .sort((a, b) => facet.country[b] - facet.country[a]);
  }, [facet.country, countrySearch]);

  if (loadingPhase !== 'ready') return null;

  const totalVisible =
    visibleFacet.type.satellite + visibleFacet.type.rocket_body +
    visibleFacet.type.debris + visibleFacet.type.unknown + visibleFacet.type.deep_space;

  const isCountryChecked = (code: string) =>
    countryFilter.mode === 'all' || countryFilter.codes.has(code);

  const toggleCountry = (code: string) => {
    const allCodes = Object.keys(facet.country);
    if (countryFilter.mode === 'all') {
      const codes = new Set(allCodes);
      codes.delete(code);
      setCountryFilter({ mode: 'only', codes });
      return;
    }
    const codes = new Set(countryFilter.codes);
    if (codes.has(code)) codes.delete(code);
    else codes.add(code);
    if (codes.size >= allCodes.length) setCountryFilter({ mode: 'all' });
    else setCountryFilter({ mode: 'only', codes });
  };

  const typeRows: FacetRowData[] = TYPE_KEYS.map((k) => ({
    key: k,
    label: TYPE_LABELS[k],
    on: typeFilters[k],
    visible: visibleFacet.type[k],
    total: facet.type[k],
    swatch: colorBy === 'type' ? rgbToCss(TYPE_COLORS[k]) : undefined,
    onToggle: () => toggleTypeFilter(k),
  }));

  const statusRows: FacetRowData[] = STATUS_KEYS
    .filter((k) => facet.status[k] > 0)
    .map((k) => ({
      key: k,
      label: ORBITAL_STATUS_LABELS[k],
      on: statusFilters[k],
      visible: visibleFacet.status[k],
      total: facet.status[k],
      swatch: colorBy === 'status' ? rgbToCss(STATUS_COLORS[k]) : undefined,
      onToggle: () => toggleStatusFilter(k),
    }));

  const sectorRows: FacetRowData[] = SECTOR_KEYS.map((k) => ({
    key: k,
    label: SECTOR_LABELS[k],
    on: sectorFilters[k],
    visible: visibleFacet.sector[k],
    total: facet.sector[k],
    swatch: colorBy === 'sector' ? rgbToCss(SECTOR_COLORS[k]) : undefined,
    onToggle: () => toggleSectorFilter(k),
  }));

  const purposeRows: FacetRowData[] = PURPOSE_KEYS
    .filter((k) => facet.purpose[k] > 0)
    .map((k) => ({
      key: k,
      label: PURPOSE_LABELS[k],
      on: purposeFilters[k],
      visible: visibleFacet.purpose[k],
      total: facet.purpose[k],
      onToggle: () => togglePurposeFilter(k),
    }));

  const regimeRows: FacetRowData[] = REGIME_KEYS.map((k) => ({
    key: k,
    label: REGIME_LABELS[k],
    on: regimeFilters[k],
    visible: visibleRegCounts[k],
    total: regimeCounts[k],
    onToggle: () => toggleRegime(k),
  }));

  const visualStatusColor = visualList.status === 'fresh'
    ? 'rgba(76, 175, 80, 0.9)'
    : visualList.status === 'stale'
      ? 'rgba(255, 193, 7, 0.95)'
      : visualList.status === 'loading'
        ? 'rgba(255, 255, 255, 0.65)'
        : 'rgba(244, 67, 54, 0.95)';

  const visualStatusLabel = visualList.status === 'fresh'
    ? 'VISUAL list: Fresh'
    : visualList.status === 'stale'
      ? 'VISUAL list: Stale cache'
      : visualList.status === 'loading'
        ? 'VISUAL list: Loading'
        : 'VISUAL list: Unavailable';

  const handleRequestLocation = async () => {
    if (isLocating) {
      return;
    }

    if (!navigator.geolocation) {
      setLocationStatusMessage('Geolocation is not supported by your browser.');
      return;
    }

    setIsLocating(true);
    setLocationStatusMessage(null);
    try {
      let position: GeolocationPosition;
      try {
        position = await geolocateOnce({
          enableHighAccuracy: true,
          timeout: 12_000,
          maximumAge: 0,
        });
      } catch (err) {
        const geoErr = err as GeolocationPositionError;
        if (geoErr.code === 1) {
          throw geoErr;
        }

        position = await geolocateOnce({
          enableHighAccuracy: false,
          timeout: 15_000,
          maximumAge: LOCATION_RETRY_MAX_AGE_MS,
        });
      }

      const location = toObserverLocation(position);
      cacheObserverLocation(location);
      setObserverLocation(location);
      setLocationStatusMessage(null);
    } catch (err) {
      const cached = readCachedObserverLocation();
      if (cached) {
        const cacheAgeMs = Date.now() - cached.savedAt;
        if (cacheAgeMs <= OBSERVER_LOCATION_CACHE_MAX_AGE_MS) {
          setObserverLocation({ lat: cached.lat, lon: cached.lon, alt: cached.alt });
          setLocationStatusMessage(
            `Live location unavailable; using saved location (${new Date(cached.savedAt).toISOString().slice(11, 19)} UTC).`,
          );
        } else {
          clearCachedObserverLocation();
          setLocationStatusMessage(
            `Live location unavailable and saved location is stale (${formatAge(cacheAgeMs)} old); not applied.`,
          );
        }
      } else {
        if (err instanceof Error) {
          setLocationStatusMessage(`Unable to retrieve location: ${err.message}`);
        } else {
          const geoErr = err as GeolocationPositionError;
          setLocationStatusMessage(getLocationErrorMessage(geoErr));
        }
      }
    } finally {
      setIsLocating(false);
    }
  };

  return (
    <>
      {/* Collapsed toggle button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            width: 36,
            height: 36,
            borderRadius: 8,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(4px)',
            color: 'rgba(255, 255, 255, 0.7)',
            cursor: 'pointer',
            fontFamily: 'monospace',
            fontSize: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto',
          }}
          title="Show filters"
        >
          &#9776;
        </button>
      )}

      {/* Main panel */}
      <div
        style={{
          ...panelStyle,
          transform: open ? 'translateX(0)' : 'translateX(-120%)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {/* Close button */}
        <button
          onClick={() => setOpen(false)}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'none',
            border: 'none',
            color: 'rgba(255, 255, 255, 0.4)',
            cursor: 'pointer',
            fontFamily: 'monospace',
            fontSize: 14,
            padding: '2px 6px',
          }}
        >
          &times;
        </button>

        <div style={sectionHeaderStyle}>Local Visibility</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
           {observerLocation === null ? (
               <>
                 <button
                    onClick={() => void handleRequestLocation()}
                    disabled={isLocating}
                    style={{
                     background: 'rgba(255, 255, 255, 0.1)',
                     border: '1px solid rgba(255, 255, 255, 0.2)',
                     color: '#fff',
                     padding: '6px 12px',
                     borderRadius: 4,
                     cursor: isLocating ? 'not-allowed' : 'pointer',
                     fontFamily: 'inherit',
                     fontSize: 11,
                     opacity: isLocating ? 0.6 : 1,
                   }}
                 >
                   {isLocating ? 'Locating...' : '📍 Use My Location'}
                 </button>
                 {locationStatusMessage && (
                   <div style={{ fontSize: 10, color: 'rgba(244, 67, 54, 0.95)', lineHeight: 1.3, marginTop: 4 }}>
                     {locationStatusMessage}
                   </div>
                 )}
               </>
            ) : (
                 <>
                   <div style={{ fontSize: 10, color: 'rgba(255, 255, 255, 0.5)', marginBottom: 4 }}>
                     Lat: {observerLocation.lat.toFixed(2)}°, Lon: {observerLocation.lon.toFixed(2)}°
                   </div>
                    <button
                      onClick={() => void handleRequestLocation()}
                      disabled={isLocating}
                      style={{
                       alignSelf: 'flex-start',
                       background: 'rgba(255, 255, 255, 0.08)',
                       border: '1px solid rgba(255, 255, 255, 0.15)',
                       color: 'rgba(255, 255, 255, 0.8)',
                       padding: '4px 8px',
                       borderRadius: 4,
                       cursor: isLocating ? 'not-allowed' : 'pointer',
                       fontFamily: 'inherit',
                       fontSize: 10,
                       opacity: isLocating ? 0.6 : 1,
                       marginBottom: 4,
                     }}
                   >
                     {isLocating ? 'Updating location...' : '↻ Update location'}
                   </button>
                   {locationStatusMessage && (
                     <div style={{ fontSize: 10, color: 'rgba(255, 193, 7, 0.95)', lineHeight: 1.3, marginBottom: 4 }}>
                       {locationStatusMessage}
                     </div>
                   )}
                   <div style={{ fontSize: 10, color: visualStatusColor, marginBottom: 4 }}>
                     {visualStatusLabel}
                     {visualList.version ? ` (${visualList.version.slice(11, 19)} UTC)` : ''}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: visibilityMode === 'all' ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                     <Toggle on={visibilityMode === 'all'} onToggle={() => setVisibilityMode('all')} />
                     <span>Show All (Global)</span>
                    {visibilityMode === 'all' && <span style={countStyle}>{totalVisible.toLocaleString()}</span>}
                 </div>
                 <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: visibilityMode === 'radio' ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                    <Toggle on={visibilityMode === 'radio'} onToggle={() => setVisibilityMode('radio')} />
                    <span>Radio Pass (&gt;10° Elev)</span>
                    {visibilityMode === 'radio' && <span style={countStyle}>{totalVisible.toLocaleString()}</span>}
                 </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: visibilityMode === 'dome' ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                     <Toggle on={visibilityMode === 'dome'} onToggle={() => setVisibilityMode('dome')} />
                     <span title="Stand at your location and look up — every object above your horizon, in true alt/azimuth. Naked-eye-visible ones glow brighter.">Sky Dome (Planetarium)</span>
                     {visibilityMode === 'dome' && <span style={countStyle}>{totalVisible.toLocaleString()}</span>}
                  </div>
                  {visualList.status === 'stale' && (
                    <div style={{ fontSize: 10, color: 'rgba(255, 193, 7, 0.95)', lineHeight: 1.3, marginTop: 2 }}>
                      Using cached curated list; results may be outdated.
                    </div>
                  )}
                  {visualList.status === 'unavailable' && (
                    <div style={{ fontSize: 10, color: 'rgba(244, 67, 54, 0.95)', lineHeight: 1.3, marginTop: 2 }}>
                      Curated visual list unavailable; Sky Dome highlights are off.
                    </div>
                  )}
                </>
            )}
         </div>

        <div style={dividerStyle} />

        {/* Color By — recolors the whole point cloud by the chosen dimension. */}
        <div style={sectionHeaderStyle}>Color By</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {COLOR_BY_OPTIONS.map(({ key, label }) => {
            const active = colorBy === key;
            return (
              <button
                key={key}
                onClick={() => setColorBy(key)}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  borderRadius: 4,
                  border: `1px solid ${active ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
                  background: active ? 'rgba(0, 229, 255, 0.18)' : 'rgba(255, 255, 255, 0.05)',
                  color: active ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 10,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div style={dividerStyle} />

        <FacetSection title="Object Type" rows={typeRows} defaultOpen />
        <FacetSection title="Orbital Regime" rows={regimeRows} defaultOpen />
        <FacetSection title="Status" rows={statusRows} />
        <FacetSection title="Sector" rows={sectorRows} />
        <FacetSection title="Purpose" rows={purposeRows} />

        {/* Country / Operator — searchable multi-select over ~120 operators. */}
        <details style={{ marginTop: 12 }}>
          <summary style={summaryStyle}>Country / Operator</summary>
          <input
            value={countrySearch}
            onChange={(e) => setCountrySearch(e.target.value)}
            placeholder="Search…"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              marginTop: 8,
              padding: '5px 8px',
              borderRadius: 4,
              border: '1px solid rgba(255, 255, 255, 0.15)',
              background: 'rgba(255, 255, 255, 0.06)',
              color: '#fff',
              fontFamily: 'inherit',
              fontSize: 11,
            }}
          />
          <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
            <button onClick={() => setCountryFilter({ mode: 'all' })} style={miniButtonStyle}>All</button>
            <button onClick={() => setCountryFilter({ mode: 'only', codes: new Set() })} style={miniButtonStyle}>None</button>
          </div>
          <div style={{ maxHeight: 168, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {countryRows.map((code) => {
              const checked = isCountryChecked(code);
              const swatch = colorBy === 'country' ? rgbToCss(COUNTRY_COLORS[code] ?? FALLBACK_GREY) : null;
              const flag = countryFlag(code);
              return (
                <div
                  key={code}
                  onClick={() => toggleCountry(code)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                    opacity: checked ? 1 : 0.4,
                    transition: 'opacity 0.15s',
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 3,
                      flexShrink: 0,
                      border: '1px solid rgba(255, 255, 255, 0.3)',
                      background: checked ? 'rgba(255, 255, 255, 0.85)' : 'transparent',
                    }}
                  />
                  {swatch && (
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: swatch, flexShrink: 0 }} />
                  )}
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {flag ? `${flag} ` : ''}{displayCountry(code)}
                  </span>
                  <span style={countStyle}>{(visibleFacet.country[code] ?? 0).toLocaleString()} / {facet.country[code].toLocaleString()}</span>
                </div>
              );
            })}
            {countryRows.length === 0 && (
              <div style={{ fontSize: 10, color: 'rgba(255, 255, 255, 0.4)' }}>No operators match.</div>
            )}
          </div>
        </details>
      </div>
    </>
  );
}

const miniButtonStyle: React.CSSProperties = {
  flex: 1,
  padding: '3px 0',
  borderRadius: 4,
  border: '1px solid rgba(255, 255, 255, 0.12)',
  background: 'rgba(255, 255, 255, 0.05)',
  color: 'rgba(255, 255, 255, 0.7)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 10,
};
