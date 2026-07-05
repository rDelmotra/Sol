import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Fuse, { type FuseResult } from 'fuse.js';
import { useStore } from '../store/useStore';
import type { EnrichedTLEObject, ObjectCategory } from '../data/types';
import { parseQuery } from '../query/parser';
import { irToFilterPatch } from '../query/executor';
import { EMPTY_IR, type QueryIR } from '../query/types';

const CATEGORY_COLORS: Record<ObjectCategory, string> = {
  active_satellite: '#4CAF50',
  inactive_satellite: '#9E9E9E',
  rocket_body: '#FFC107',
  debris: '#F44336',
  unknown: '#757575',
  deep_space: '#00BCD4',
};

const DEBOUNCE_MS = 150;

export function SearchBar() {
  const catalogData = useStore((s) => s.catalogData);
  const selectByIndex = useStore((s) => s.selectByIndex);
  const loadingPhase = useStore((s) => s.loadingPhase);
  const hasSelection = useStore((s) => !!(s.selectedSatellite || s.selectedDso));
  const applyQueryFilters = useStore((s) => s.applyQueryFilters);
  const clearQueryFilters = useStore((s) => s.clearQueryFilters);
  const visibleFacetCounts = useStore((s) => s.visibleFacetCounts);
  const facetCounts = useStore((s) => s.facetCounts);

  const [query, setQuery] = useState('');
  const [ir, setIr] = useState<QueryIR>(EMPTY_IR);
  const [results, setResults] = useState<FuseResult<EnrichedTLEObject>[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  // Build Fuse index once when catalogData arrives
  const fuse = useMemo(() => {
    if (catalogData.length === 0) return null;
    return new Fuse(catalogData, {
      keys: [
        { name: 'name', weight: 0.7 },
        { name: 'noradId', weight: 0.3 },
      ],
      threshold: 0.4,
      getFn: (obj, path) => {
        const key = Array.isArray(path) ? path[0] : path;
        if (key === 'noradId') return String((obj as EnrichedTLEObject).noradId);
        return Fuse.config.getFn(obj, path);
      },
    });
  }, [catalogData]);

  // Compile + apply a query: parse → facet filters (live), residual → Fuse.
  // The whole-word rule is structural in the parser (exact-key lookups), so a
  // mid-typed token can't transiently match; unchanged constraints are
  // reference-preserved in the store (reconcileFilterSlices) so keystrokes
  // that only extend residual text never trigger a renderer recompute.
  const runQuery = useCallback(
    (value: string) => {
      const nextIr = parseQuery(value);
      setIr(nextIr);
      applyQueryFilters(irToFilterPatch(nextIr));
      const residual = nextIr.text;
      setResults(residual && fuse ? fuse.search(residual, { limit: 10 }) : []);
      setHighlightedIndex(0);
    },
    [fuse, applyQueryFilters],
  );

  const resetQueryState = useCallback(() => {
    setIr(EMPTY_IR);
    setResults([]);
    setHighlightedIndex(0);
    clearQueryFilters();
  }, [clearQueryFilters]);

  // Debounced pipeline; empty input restores the swarm synchronously.
  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!value.trim()) {
        resetQueryState();
        return;
      }
      debounceRef.current = setTimeout(() => runQuery(value), DEBOUNCE_MS);
    },
    [runQuery, resetQueryState],
  );

  // Remove one interpretation chip: splice its span out of the input text and
  // re-run immediately (input text stays the single source of truth).
  const removeChip = useCallback(
    (start: number, end: number) => {
      const next = (query.slice(0, start) + query.slice(end)).replace(/\s{2,}/g, ' ').trim();
      setQuery(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!next) resetQueryState();
      else runQuery(next);
    },
    [query, runQuery, resetQueryState],
  );

  // Select a result — releases the query filter (query text is cleared).
  const selectResult = useCallback(
    (refIndex: number) => {
      if (selectByIndex) selectByIndex(refIndex);
      setQuery('');
      resetQueryState();
      setIsOpen(false);
      inputRef.current?.blur();
    },
    [selectByIndex, resetQueryState],
  );

  // Keyboard navigation
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && results.length > 0) {
        e.preventDefault();
        const hit = results[highlightedIndex];
        if (hit?.refIndex != null) selectResult(hit.refIndex);
      } else if (e.key === 'Escape') {
        setQuery('');
        resetQueryState();
        setIsOpen(false);
        inputRef.current?.blur();
      }
    },
    [results, highlightedIndex, selectResult, resetQueryState],
  );

  // Unmount / hot-reload safety: never strand a collapsed swarm.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      clearQueryFilters();
    };
  }, [clearQueryFilters]);

  // "/" global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === '/') {
        e.preventDefault();
        inputRef.current?.focus();
        setIsOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setResults([]);
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (loadingPhase !== 'ready') return null;

  const showDropdown = isOpen && results.length > 0;
  const showChips = ir.matches.length > 0 && query.trim() !== '';
  const visibleTotal = Object.values(visibleFacetCounts.type).reduce((a, b) => a + b, 0);
  const catalogTotal = Object.values(facetCounts.type).reduce((a, b) => a + b, 0);

  const dynamicInputStyle: React.CSSProperties = {
    ...inputStyle,
    borderRadius: hasSelection && !showDropdown ? '8px 8px 0 0' : '8px',
    borderBottom: hasSelection && !showDropdown ? 'none' : '1px solid rgba(255, 255, 255, 0.1)',
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      <div style={inputWrapperStyle}>
        <span style={iconStyle}>&#x2315;</span>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search satellites...  (/)"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => setIsOpen(true)}
          onKeyDown={onKeyDown}
          style={dynamicInputStyle}
        />
      </div>
      {showChips && (
        <div style={chipsRowStyle}>
          {ir.matches.map((m, i) => (
            <span key={`${m.group}-${m.value}-${i}`} style={chipStyle}>
              {m.label}
              <span
                style={chipRemoveStyle}
                onMouseDown={(e) => {
                  e.preventDefault();
                  removeChip(m.start, m.end);
                }}
              >
                ×
              </span>
            </span>
          ))}
          <span style={countLineStyle}>
            {visibleTotal.toLocaleString()} of {catalogTotal.toLocaleString()} objects
          </span>
        </div>
      )}
      {showDropdown && (
        <div style={dropdownStyle}>
          {results.map((hit, i) => {
            const obj = hit.item;
            return (
              <div
                key={obj.noradId}
                style={{
                  ...resultItemStyle,
                  background:
                    i === highlightedIndex ? 'rgba(255,255,255,0.08)' : 'transparent',
                }}
                onMouseEnter={() => setHighlightedIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (hit.refIndex != null) selectResult(hit.refIndex);
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: CATEGORY_COLORS[obj.category as ObjectCategory],
                    marginRight: 8,
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {obj.name}
                </span>
                <span style={{ color: 'rgba(255,255,255,0.35)', marginLeft: 8, flexShrink: 0 }}>
                  {obj.noradId}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  pointerEvents: 'auto',
  zIndex: 20,
};

const inputWrapperStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
};

const iconStyle: React.CSSProperties = {
  position: 'absolute',
  left: 10,
  color: 'rgba(255,255,255,0.35)',
  fontSize: '14px',
  pointerEvents: 'none',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px 8px 30px',
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  fontFamily: 'monospace',
  fontSize: '12px',
  color: 'rgba(255, 255, 255, 0.85)',
  outline: 'none',
};

const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  right: 0,
  marginTop: 4,
  background: 'rgba(0, 0, 0, 0.85)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  overflow: 'hidden',
  maxHeight: 360,
  zIndex: 20,
};

const resultItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '7px 12px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: '12px',
  color: 'rgba(255, 255, 255, 0.85)',
};

const chipsRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  marginTop: 4,
  pointerEvents: 'auto',
};

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '2px 7px',
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.18)',
  borderRadius: 10,
  fontFamily: 'monospace',
  fontSize: '11px',
  color: 'rgba(255, 255, 255, 0.85)',
};

const chipRemoveStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: 'rgba(255, 255, 255, 0.4)',
  fontSize: '12px',
  lineHeight: 1,
};

const countLineStyle: React.CSSProperties = {
  marginLeft: 'auto',
  fontFamily: 'monospace',
  fontSize: '10px',
  color: 'rgba(255, 255, 255, 0.4)',
  whiteSpace: 'nowrap',
};
