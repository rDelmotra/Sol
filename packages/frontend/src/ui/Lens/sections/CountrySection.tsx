import { useState, type CSSProperties } from 'react';
import { useStore } from '../../../store/useStore';
import { Toggle } from '../../primitives';
import { displayCountry, countryFlag } from '../../../data/country-codes';
import { lensSectionTitleStyle } from '../shared';

const searchInputStyle: CSSProperties = {
  width: '100%',
  marginBottom: 10,
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxHeight: 280,
  overflowY: 'auto',
  overflowX: 'hidden',
};

const rowStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderRadius: 'var(--ow-r-sm)',
  overflow: 'hidden',
};

const rowFillStyle: CSSProperties = {
  position: 'absolute',
  inset: '0 auto 0 0',
  background: 'var(--ow-surface-hover)',
  zIndex: 0,
  transition: 'width var(--ow-dur-3) var(--ow-ease)',
};

const rowLeftStyle: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  overflow: 'hidden',
  minWidth: 0,
};

const rowNameStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-display)',
  fontSize: 12,
  color: 'var(--ow-text-mid)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const rowRightStyle: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
};

const rowCountStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-mono)',
  fontSize: 10,
  color: 'var(--ow-text-faint)',
};

/**
 * "Country" facet section of the Lens sheet — a searchable list (150+ entries,
 * not a pill cloud like the other facets). Toggle-set semantics are ported
 * verbatim from the old TopTaskbar `CountryFilterMenu`: 'all' mode flips a
 * single click into an 'only' set with that code excluded; 'only' mode toggles
 * membership and collapses back to 'all' once every known code is present.
 *
 * New here (the old menu had no per-row bar): each row gets an inline fill
 * behind its content, width = visible/total for that country, so the list
 * doubles as a mini histogram like the pill-based facets elsewhere in the sheet.
 */
export function CountrySection() {
  const countryFilter = useStore((s) => s.countryFilter);
  const setCountryFilter = useStore((s) => s.setCountryFilter);
  const facetCounts = useStore((s) => s.facetCounts);
  const visibleFacetCounts = useStore((s) => s.visibleFacetCounts);

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
    <div>
      <div style={lensSectionTitleStyle}>Country</div>
      <input
        type="text"
        className="ow-input"
        placeholder="Filter countries..."
        value={countrySearch}
        onChange={(e) => setCountrySearch(e.target.value)}
        style={searchInputStyle}
      />
      <div className="ow-scroll" style={listStyle}>
        {countryRows.map((code) => {
          const total = facetCounts.country[code];
          const visible = visibleFacetCounts.country[code] ?? 0;
          const percent = total > 0 ? (visible / total) * 100 : 0;
          return (
            <div key={code} style={rowStyle}>
              <div style={{ ...rowFillStyle, width: `${percent}%` }} />
              <div style={rowLeftStyle}>
                <span>{countryFlag(code)}</span>
                <span style={rowNameStyle}>{displayCountry(code)}</span>
              </div>
              <div style={rowRightStyle}>
                <span style={rowCountStyle}>{total.toLocaleString()}</span>
                <Toggle on={isCountryChecked(code)} onToggle={() => toggleCountry(code)} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
