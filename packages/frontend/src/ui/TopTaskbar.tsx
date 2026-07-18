import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { DropdownMenu } from './DropdownMenu';
import { 
  REGIME_KEYS, REGIME_LABELS, 
  TYPE_KEYS, TYPE_LABELS,
  STATUS_KEYS, SECTOR_KEYS, PURPOSE_KEYS,
  Toggle,
  geolocateOnce, toObserverLocation, cacheObserverLocation, 
  readCachedObserverLocation, clearCachedObserverLocation, 
  formatAge, getLocationErrorMessage, LOCATION_RETRY_MAX_AGE_MS, 
  OBSERVER_LOCATION_CACHE_MAX_AGE_MS
} from './Lens/shared';
import { SearchBar } from './SearchBar';
import { displayCountry, countryFlag } from '../data/country-codes';

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

// --------------------------------------------------------
// Mini-HUD Subcomponents for the Dropdown Menus
// --------------------------------------------------------
function TypeFilterMenu() {
  const typeFilters = useStore((s) => s.typeFilters);
  const toggleTypeFilter = useStore((s) => s.toggleTypeFilter);
  const facetCounts = useStore((s) => s.facetCounts);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {TYPE_KEYS.map((typeKey) => (
        <div key={typeKey} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)' }}>
            {TYPE_LABELS[typeKey]}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--ow-text-faint)', fontFamily: 'var(--ow-font-mono)' }}>
              {facetCounts.type[typeKey].toLocaleString()}
            </span>
            <Toggle on={typeFilters[typeKey]} onToggle={() => toggleTypeFilter(typeKey)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusFilterMenu() {
  const statusFilters = useStore((s) => s.statusFilters);
  const toggleStatusFilter = useStore((s) => s.toggleStatusFilter);
  const facetCounts = useStore((s) => s.facetCounts);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {STATUS_KEYS.map((key) => (
        <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)', textTransform: 'capitalize' }}>
            {key.replace('_', ' ')}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--ow-text-faint)', fontFamily: 'var(--ow-font-mono)' }}>
              {facetCounts.status[key].toLocaleString()}
            </span>
            <Toggle on={statusFilters[key]} onToggle={() => toggleStatusFilter(key)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SectorFilterMenu() {
  const sectorFilters = useStore((s) => s.sectorFilters);
  const toggleSectorFilter = useStore((s) => s.toggleSectorFilter);
  const facetCounts = useStore((s) => s.facetCounts);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {SECTOR_KEYS.map((key) => (
        <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)', textTransform: 'capitalize' }}>
            {key.replace('_', ' ')}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--ow-text-faint)', fontFamily: 'var(--ow-font-mono)' }}>
              {facetCounts.sector[key].toLocaleString()}
            </span>
            <Toggle on={sectorFilters[key]} onToggle={() => toggleSectorFilter(key)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PurposeFilterMenu() {
  const purposeFilters = useStore((s) => s.purposeFilters);
  const togglePurposeFilter = useStore((s) => s.togglePurposeFilter);
  const facetCounts = useStore((s) => s.facetCounts);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {PURPOSE_KEYS.map((key) => (
        <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)', textTransform: 'capitalize' }}>
            {key.replace('_', ' ')}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--ow-text-faint)', fontFamily: 'var(--ow-font-mono)' }}>
              {facetCounts.purpose[key].toLocaleString()}
            </span>
            <Toggle on={purposeFilters[key]} onToggle={() => togglePurposeFilter(key)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function CountryFilterMenu() {
  const countryFilter = useStore((s) => s.countryFilter);
  const setCountryFilter = useStore((s) => s.setCountryFilter);
  const facetCounts = useStore((s) => s.facetCounts);
  
  const [countrySearch, setCountrySearch] = useState('');

  const toggleCountry = (code: string) => {
    const allCodes = Object.keys(facetCounts.country);
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

  const isCountryChecked = (code: string) =>
    countryFilter.mode === 'all' || countryFilter.codes.has(code);

  const countryRows = Object.keys(facetCounts.country)
    .filter((code) => {
      const q = countrySearch.trim().toLowerCase();
      if (!q) return true;
      return code.toLowerCase().includes(q) || displayCountry(code).toLowerCase().includes(q);
    })
    .sort((a, b) => facetCounts.country[b] - facetCounts.country[a]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4 }}>
      <input
        type="text"
        placeholder="Filter countries..."
        value={countrySearch}
        onChange={(e) => setCountrySearch(e.target.value)}
        style={{
          width: '100%',
          padding: '6px 8px',
          background: 'var(--ow-surface-2)',
          border: '1px solid var(--ow-stroke)',
          borderRadius: 6,
          color: 'var(--ow-text-hi)',
          fontFamily: 'var(--ow-font-mono)',
          fontSize: 11,
          marginBottom: 4,
          outline: 'none',
        }}
      />
      {countryRows.map((code) => (
        <div key={code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
            <span style={{ fontSize: 14 }}>{countryFlag(code)}</span>
            <span style={{ fontSize: 11, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>
              {displayCountry(code)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--ow-text-faint)', fontFamily: 'var(--ow-font-mono)' }}>
              {facetCounts.country[code].toLocaleString()}
            </span>
            <Toggle on={isCountryChecked(code)} onToggle={() => toggleCountry(code)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ColorByMenu() {
  const colorBy = useStore((s) => s.colorBy);
  const setColorBy = useStore((s) => s.setColorBy);
  const options = ['type', 'status', 'sector', 'country'] as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => setColorBy(opt)}
          style={{
            background: colorBy === opt ? 'var(--ow-perceptor-soft)' : 'transparent',
            border: `1px solid ${colorBy === opt ? 'var(--ow-perceptor-line)' : 'transparent'}`,
            borderRadius: 6,
            padding: '6px 12px',
            color: colorBy === opt ? 'var(--ow-text-hi)' : 'var(--ow-text-lo)',
            textAlign: 'left',
            fontFamily: 'var(--ow-font-mono)',
            fontSize: 11,
            cursor: 'pointer',
            textTransform: 'capitalize'
          }}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function PerspectiveSubMenu() {
  const observerLocation = useStore((s) => s.observerLocation);
  const setObserverLocation = useStore((s) => s.setObserverLocation);
  const showObserverDome = useStore((s) => s.showObserverDome);
  const setShowObserverDome = useStore((s) => s.setShowObserverDome);
  
  const [isLocating, setIsLocating] = useState(false);
  const [locationStatusMessage, setLocationStatusMessage] = useState<string | null>(null);

  const handleRequestLocation = async () => {
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
        if (geoErr.code === 1) throw geoErr;
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
    <div style={{
      position: 'absolute',
      top: 'calc(100% + 8px)',
      left: 0,
      background: 'var(--ow-surface-3)',
      backdropFilter: 'blur(var(--ow-blur-3))',
      WebkitBackdropFilter: 'blur(var(--ow-blur-3))',
      border: '1px solid var(--ow-stroke)',
      borderRadius: 'var(--ow-r-lg)',
      boxShadow: 'var(--ow-shadow-2)',
      padding: '12px 16px',
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minWidth: 200,
    }}>
      {observerLocation === null ? (
        <>
          <button
            onClick={() => void handleRequestLocation()}
            disabled={isLocating}
            style={{
              background: 'var(--ow-perceptor-soft)',
              border: '1px solid var(--ow-perceptor-line)',
              color: 'var(--ow-perceptor)',
              padding: '6px 12px',
              borderRadius: 6,
              cursor: isLocating ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--ow-font-mono)',
              fontSize: 11,
              opacity: isLocating ? 0.6 : 1,
              transition: 'all 0.2s',
            }}
          >
            {isLocating ? 'Locating...' : '📍 Use My Location'}
          </button>
          {locationStatusMessage && (
            <div style={{ fontSize: 10, color: 'var(--ow-danger)', lineHeight: 1.3 }}>
              {locationStatusMessage}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 10, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)' }}>
              Lat: {observerLocation.lat.toFixed(2)}°
            </div>
            <div style={{ fontSize: 10, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)' }}>
              Lon: {observerLocation.lon.toFixed(2)}°
            </div>
          </div>
          
          <button
            onClick={() => void handleRequestLocation()}
            disabled={isLocating}
            style={{
              alignSelf: 'flex-start',
              background: 'transparent',
              border: 'none',
              color: 'var(--ow-perceptor)',
              padding: 0,
              cursor: isLocating ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--ow-font-mono)',
              fontSize: 10,
              opacity: isLocating ? 0.6 : 1,
            }}
          >
            {isLocating ? 'Updating location...' : '↻ Update location'}
          </button>
          {locationStatusMessage && (
            <div style={{ fontSize: 10, color: 'var(--ow-warn)', lineHeight: 1.3 }}>
              {locationStatusMessage}
            </div>
          )}

          <div style={{ height: 1, background: 'var(--ow-stroke)', margin: '4px 0' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)', flex: 1 }}>Show Horizon Dome</span>
            <Toggle on={showObserverDome} onToggle={() => setShowObserverDome(!showObserverDome)} />
          </div>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------
// Main TopTaskbar Component
// --------------------------------------------------------
export function TopTaskbar() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const objectCount = useStore((s) => s.objectCount);
  const dataTimestamp = useStore((s) => s.dataTimestamp);
  const simTimeMs = useStore((s) => s.simTimeMs);
  
  const regimeFilters = useStore((s) => s.regimeFilters);
  const toggleRegimeFilter = useStore((s) => s.toggleRegimeFilter);
  
  const visibilityMode = useStore((s) => s.visibilityMode);
  const setVisibilityMode = useStore((s) => s.setVisibilityMode);

  // Derive active counts
  const typeFilters = useStore((s) => s.typeFilters);
  const activeTypesCount = Object.values(typeFilters).filter(Boolean).length;
  const statusFilters = useStore((s) => s.statusFilters);
  const activeStatusCount = Object.values(statusFilters).filter(Boolean).length;
  const sectorFilters = useStore((s) => s.sectorFilters);
  const activeSectorCount = Object.values(sectorFilters).filter(Boolean).length;
  const purposeFilters = useStore((s) => s.purposeFilters);
  const activePurposeCount = Object.values(purposeFilters).filter(Boolean).length;
  
  const countryFilter = useStore((s) => s.countryFilter);
  const facetCounts = useStore((s) => s.facetCounts);
  const activeCountryCount = countryFilter.mode === 'all' 
    ? Object.keys(facetCounts.country).length 
    : countryFilter.codes.size;
  
  const utc = formatUTC(new Date(simTimeMs));
  const [freshness, setFreshness] = useState(() => formatFreshness(dataTimestamp));

  useEffect(() => {
    setFreshness(formatFreshness(dataTimestamp));
    if (dataTimestamp === null) return;
    const id = setInterval(() => setFreshness(formatFreshness(dataTimestamp)), 60_000);
    return () => clearInterval(id);
  }, [dataTimestamp]);

  if (loadingPhase !== 'ready') return null;

  return (
    <div style={{
      position: 'absolute',
      top: 0, left: 0, right: 0,
      height: 60,
      background: 'var(--ow-surface-2)',
      backdropFilter: 'blur(var(--ow-blur-2))',
      WebkitBackdropFilter: 'blur(var(--ow-blur-2))',
      borderBottom: '1px solid var(--ow-stroke)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      pointerEvents: 'auto',
      zIndex: 100,
    }}>
      {/* LEFT: HUD Info & Perspective */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'var(--ow-font-mono)' }}>
          <span style={{ fontSize: 12, color: 'var(--ow-text-hi)' }}>{utc}</span>
          <span style={{ fontSize: 10, color: 'var(--ow-text-lo)' }}>Tracking {objectCount.toLocaleString()}</span>
          <span style={{ fontSize: 9, color: 'var(--ow-text-faint)' }}>{freshness}</span>
        </div>

        {/* Perspective Switch */}
        <div style={{
          display: 'flex',
          background: 'transparent',
          borderRadius: 16,
          padding: 2,
          position: 'relative'
        }}>
          <div style={{
            position: 'absolute',
            top: 2, bottom: 2,
            left: visibilityMode === 'all' ? 2 : visibilityMode === 'radio' ? '33.33%' : '66.66%',
            width: 'calc(33.33% - 1.33px)',
            background: 'var(--ow-perceptor-soft)',
            border: '1px solid var(--ow-perceptor-line)',
            borderRadius: 14,
            transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
            boxShadow: '0 0 12px var(--ow-perceptor-soft)'
          }} />
          {(['all', 'radio', 'dome'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setVisibilityMode(mode)}
              style={{
                position: 'relative',
                flex: 1, padding: '6px 16px',
                background: 'transparent', border: 'none',
                color: visibilityMode === mode ? 'var(--ow-text-hi)' : 'var(--ow-text-lo)',
                fontFamily: 'var(--ow-font-mono)', fontSize: 11, cursor: 'pointer',
                transition: 'color 0.2s', zIndex: 1,
                whiteSpace: 'nowrap'
              }}
            >
              {mode === 'all' ? 'Global' : mode === 'radio' ? 'Radio Pass' : 'Sky Dome'}
            </button>
          ))}
          {/* Contextual location submenu for non-global perspectives */}
          {(visibilityMode === 'radio' || visibilityMode === 'dome') && (
            <PerspectiveSubMenu />
          )}
        </div>
      </div>

      {/* CENTER: Orbital Regimes */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {REGIME_KEYS.map((key) => (
          <button
            key={key}
            onClick={() => toggleRegimeFilter(key)}
            style={{
              background: regimeFilters[key] ? 'var(--ow-perceptor-soft)' : 'transparent',
              border: `1px solid ${regimeFilters[key] ? 'var(--ow-perceptor-line)' : 'var(--ow-stroke)'}`,
              borderRadius: 16,
              padding: '4px 12px',
              color: regimeFilters[key] ? 'var(--ow-perceptor)' : 'var(--ow-text-lo)',
              fontFamily: 'var(--ow-font-mono)',
              fontSize: 11,
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {REGIME_LABELS[key]}
          </button>
        ))}
      </div>

      {/* RIGHT: Dropdown Filters & Search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} id="top-taskbar-right-panel">
        <DropdownMenu label="Types" activeCount={activeTypesCount}>
          <TypeFilterMenu />
        </DropdownMenu>
        
        <DropdownMenu label="Status" activeCount={activeStatusCount}>
          <StatusFilterMenu />
        </DropdownMenu>

        <DropdownMenu label="Sector" activeCount={activeSectorCount}>
          <SectorFilterMenu />
        </DropdownMenu>

        <DropdownMenu label="Purpose" activeCount={activePurposeCount}>
          <PurposeFilterMenu />
        </DropdownMenu>

        <DropdownMenu label="Country" activeCount={activeCountryCount}>
          <CountryFilterMenu />
        </DropdownMenu>

        <DropdownMenu label="Color By" width={160}>
          <ColorByMenu />
        </DropdownMenu>

        <div style={{ marginLeft: 16 }}>
           <SearchBar />
        </div>
      </div>
    </div>
  );
}
