import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Fuse, { type FuseResult } from 'fuse.js';
import { useStore } from '../store/useStore';
import type { EnrichedTLEObject, ObjectCategory } from '@orbitwatch/contracts';
import { parseQuery } from '../query/parser';
import { irToFilterPatch } from '../query/executor';
import { ensureQueryVocab } from '../query/vocab';
import { EMPTY_IR, type QueryIR } from '../query/types';
import { useAnalyticAsk } from './useAnalyticAsk';

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
  const setInjectSearchQuery = useStore((s) => s.setInjectSearchQuery);
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

  // ── Ask affordance (P2) ────────────────────────────────────────────────────
  // A RAW query (chips included — the compiler wants the full sentence, not the
  // post-chip residual) of ≥2 words offers an "Ask" row pinned FIRST in the
  // dropdown. Dispatching moves the question into the AnswerCard and releases
  // the tier-0 facet chips so the analytic allow-set stands alone (no confusing
  // AND of chips × answer).
  const ask = useAnalyticAsk();
  const askText = query.trim().replace(/\s+/g, ' ');
  const canAsk = askText.split(' ').filter(Boolean).length >= 2;
  const askOffset = canAsk ? 1 : 0;

  const dispatchAsk = useCallback(() => {
    ask(askText);
    setQuery('');
    resetQueryState();
    setIsOpen(false);
    inputRef.current?.blur();
  }, [ask, askText, resetQueryState]);

  // Keyboard navigation over the unified list: index 0 = ask row (when present),
  // Fuse results follow.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const listLength = askOffset + results.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, Math.max(listLength - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && listLength > 0) {
        e.preventDefault();
        if (canAsk && highlightedIndex === 0) {
          dispatchAsk();
          return;
        }
        const hit = results[highlightedIndex - askOffset];
        if (hit?.refIndex != null) selectResult(hit.refIndex);
      } else if (e.key === 'Escape') {
        setQuery('');
        resetQueryState();
        setIsOpen(false);
        inputRef.current?.blur();
      }
    },
    [results, highlightedIndex, selectResult, resetQueryState, canAsk, askOffset, dispatchAsk],
  );

  // Unmount / hot-reload safety: never strand a collapsed swarm.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      clearQueryFilters();
    };
  }, [clearQueryFilters]);

  // Fetch + install the launch-graph vocab once (non-blocking). On arrival,
  // retro-compile whatever is already typed so a vehicle/site/owner word entered
  // before the vocab landed becomes a chip. Refs keep this a one-shot mount effect.
  const queryRef = useRef(query);
  queryRef.current = query;
  const runQueryRef = useRef(runQuery);
  runQueryRef.current = runQuery;
  useEffect(() => {
    void ensureQueryVocab().then(() => {
      if (queryRef.current.trim()) runQueryRef.current(queryRef.current);
    });
  }, []);

  // Register the programmatic-injection slot the InfoCard pivots drive: REPLACE
  // the query, bypass the debounce, run the pipeline immediately, open the chips.
  useEffect(() => {
    setInjectSearchQuery((text: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setQuery(text);
      if (!text.trim()) {
        resetQueryState();
        return;
      }
      runQuery(text);
      setIsOpen(true);
      inputRef.current?.focus();
    });
    return () => setInjectSearchQuery(null);
  }, [setInjectSearchQuery, runQuery, resetQueryState]);

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

  const showDropdown = isOpen && (results.length > 0 || canAsk);
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
          {canAsk && (
            <div
              style={{
                ...resultItemStyle,
                background: highlightedIndex === 0 ? 'rgba(255,255,255,0.08)' : 'transparent',
              }}
              onMouseEnter={() => setHighlightedIndex(0)}
              onMouseDown={(e) => {
                e.preventDefault();
                dispatchAsk();
              }}
            >
              <span style={{ color: '#B39DDB', marginRight: 8, flexShrink: 0 }}>✦</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Ask: “{askText}”
              </span>
            </div>
          )}
          {results.map((hit, i) => {
            const obj = hit.item;
            const listIndex = i + askOffset;
            return (
              <div
                key={obj.noradId}
                style={{
                  ...resultItemStyle,
                  background:
                    listIndex === highlightedIndex ? 'rgba(255,255,255,0.08)' : 'transparent',
                }}
                onMouseEnter={() => setHighlightedIndex(listIndex)}
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
