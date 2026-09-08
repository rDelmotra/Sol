// ============================================================
// AnswerCard (P2/S8 — my_plans/marvin/perceptor_p2_plan.md).
//
// Renders the store's `analyticAnswer` slice under the SearchBar. Visual
// language: cyan = physical telemetry (HUD/InfoCard); VIOLET = derived
// intelligence (the perceptor layer) — same glass-panel style as the rest of
// the overlay so it reads native, with a thin violet accent line on top.
//
// Honesty surfaces, in render order: the question verbatim → the compiler's
// stated interpretation ("reading as:") → the executor's numbers → the basis
// (scanned count, sim-time, ⚠ per coverage entry <95%). Numbers only ever come
// from the executor; this component formats, never computes.
// ============================================================

import { useStore } from '../store/useStore';
import type { AnalyticResult, CoverageEntry } from '@orbitwatch/analytic';

const VIOLET = '#B39DDB';
const VIOLET_DIM = 'rgba(179, 157, 219, 0.55)';
const AMBER = '#FFB74D';
const COVERAGE_CAVEAT_THRESHOLD = 0.95;
const MAX_TABLE_ROWS = 10;

// ── Formatting helpers (display only — no math beyond rounding) ──────────────

function fmtNumber(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  if (Math.abs(v) >= 100) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return v.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return fmtNumber(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function fmtSimTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(11, 19)} UTC`;
}

// ── Result body by shape ──────────────────────────────────────────────────────

function ResultBody({ result }: { result: AnalyticResult }) {
  switch (result.shape) {
    case 'ids': {
      const n = result.ids?.length ?? 0;
      return (
        <div>
          <span style={bigNumberStyle}>{n.toLocaleString('en-US')}</span>
          <span style={bigNumberUnitStyle}>
            {n === 1 ? ' object' : ' objects'} highlighted on the globe
          </span>
        </div>
      );
    }
    case 'scalar':
      return (
        <div>
          <span style={bigNumberStyle}>
            {typeof result.value === 'number' ? fmtNumber(result.value) : fmtCell(result.value)}
          </span>
        </div>
      );
    case 'object':
    case 'table':
    case 'grouped': {
      const rows = result.rows ?? [];
      if (rows.length === 0) return <div style={emptyStyle}>no matching objects</div>;
      const columns = Object.keys(rows[0]);
      const shown = rows.slice(0, MAX_TABLE_ROWS);
      return (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} style={thStyle}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c} style={tdStyle}>{fmtCell(row[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > MAX_TABLE_ROWS && (
            <div style={moreRowsStyle}>… {(rows.length - MAX_TABLE_ROWS).toLocaleString('en-US')} more</div>
          )}
        </div>
      );
    }
  }
}

function ZeroMatchNotice() {
  return (
    <div style={zeroMatchStyle}>
      <div style={zeroMatchHeadlineStyle}>No objects matched.</div>
      <div>
        If the question named a specific satellite, program, or owner, that value may not
        exist in the catalog under that name — try a broader search or check the spelling.
      </div>
    </div>
  );
}

function CoverageCaveats({ coverage }: { coverage: CoverageEntry[] }) {
  const thin = coverage.filter((c) => c.total > 0 && c.present / c.total < COVERAGE_CAVEAT_THRESHOLD);
  if (thin.length === 0) return null;
  return (
    <>
      {thin.map((c) => (
        <div key={c.field} style={caveatStyle}>
          ⚠ {c.field} known for {((c.present / c.total) * 100).toFixed(1)}% of objects
        </div>
      ))}
    </>
  );
}

// ── The card ──────────────────────────────────────────────────────────────────

export function AnswerCard() {
  const answer = useStore((s) => s.analyticAnswer);
  const clearAnalyticAnswer = useStore((s) => s.clearAnalyticAnswer);

  if (!answer) return null;

  return (
    <div style={cardStyle}>
      {/* keyframes for the compiling pulse — scoped, injected once per card */}
      <style>{`@keyframes owAnswerPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }`}</style>
      <div style={accentLineStyle} />

      <div style={headerRowStyle}>
        <span style={questionStyle}>“{answer.question}”</span>
        <span
          style={closeStyle}
          title="Dismiss (clears the globe highlight)"
          onMouseDown={(e) => {
            e.preventDefault();
            clearAnalyticAnswer();
          }}
        >
          ×
        </span>
      </div>

      {answer.status === 'compiling' && (
        <div style={compilingStyle}>
          <span style={{ color: VIOLET }}>✦</span> compiling
          <span style={{ animation: 'owAnswerPulse 1s ease-in-out infinite', marginLeft: 2 }}>▊</span>
        </div>
      )}

      {answer.status === 'error' && <div style={errorStyle}>{answer.message}</div>}

      {answer.status === 'ready' && answer.result && (
        <>
          {answer.interpretation && (
            <div style={interpretationStyle}>
              <span style={{ color: VIOLET_DIM }}>reading as: </span>
              {answer.interpretation}
            </div>
          )}

          <div style={dividerStyle} />
          {answer.result.meta.matched === 0 ? <ZeroMatchNotice /> : <ResultBody result={answer.result} />}

          {answer.result.compare && (
            <>
              <div style={compareLabelStyle}>vs</div>
              <ResultBody result={answer.result.compare} />
            </>
          )}

          <div style={dividerStyle} />
          <div style={metaStyle}>
            {answer.result.meta.scanned.toLocaleString('en-US')} scanned · evaluated{' '}
            {fmtSimTime(answer.result.meta.evaluatedAt)} (sim)
          </div>
          <CoverageCaveats coverage={answer.result.meta.coverage} />
        </>
      )}
    </div>
  );
}

// ── Styles (glass panel matching HUD/InfoCard; violet = derived answers) ──────

const cardStyle: React.CSSProperties = {
  position: 'relative',
  marginTop: 8,
  padding: '10px 12px 10px',
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  fontFamily: 'monospace',
  fontSize: '12px',
  color: 'rgba(255, 255, 255, 0.85)',
  pointerEvents: 'auto',
  overflow: 'hidden',
};

const accentLineStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 1,
  background: `linear-gradient(90deg, transparent, ${VIOLET}, transparent)`,
};

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
};

const questionStyle: React.CSSProperties = {
  flex: 1,
  color: 'rgba(255, 255, 255, 0.55)',
  fontStyle: 'italic',
  fontSize: '11px',
  lineHeight: 1.4,
  wordBreak: 'break-word',
};

const closeStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: 'rgba(255, 255, 255, 0.4)',
  fontSize: '15px',
  lineHeight: 1,
  flexShrink: 0,
};

const compilingStyle: React.CSSProperties = {
  marginTop: 8,
  color: 'rgba(255, 255, 255, 0.6)',
  fontSize: '11px',
  letterSpacing: '0.05em',
};

const errorStyle: React.CSSProperties = {
  marginTop: 8,
  color: AMBER,
  fontSize: '11px',
  lineHeight: 1.5,
};

const interpretationStyle: React.CSSProperties = {
  marginTop: 8,
  color: 'rgba(255, 255, 255, 0.75)',
  fontSize: '11px',
  lineHeight: 1.5,
};

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: 'rgba(255, 255, 255, 0.08)',
  margin: '9px 0',
};

const bigNumberStyle: React.CSSProperties = {
  fontSize: '22px',
  fontWeight: 600,
  color: VIOLET,
  letterSpacing: '0.02em',
};

const bigNumberUnitStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'rgba(255, 255, 255, 0.6)',
  marginLeft: 6,
};

const emptyStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.5)',
  fontSize: '11px',
};

const zeroMatchStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.65)',
  fontSize: '11px',
  lineHeight: 1.5,
};

const zeroMatchHeadlineStyle: React.CSSProperties = {
  color: VIOLET_DIM,
  fontSize: '13px',
  fontWeight: 600,
  marginBottom: 4,
};

const tableStyle: React.CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
  fontSize: '11px',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '2px 8px 3px 0',
  color: VIOLET_DIM,
  fontWeight: 400,
  borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '3px 8px 3px 0',
  color: 'rgba(255, 255, 255, 0.85)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 140,
};

const moreRowsStyle: React.CSSProperties = {
  marginTop: 4,
  color: 'rgba(255, 255, 255, 0.4)',
  fontSize: '10px',
};

const compareLabelStyle: React.CSSProperties = {
  margin: '6px 0 2px',
  color: VIOLET_DIM,
  fontSize: '10px',
  letterSpacing: '0.15em',
  textTransform: 'uppercase',
};

const metaStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.4)',
  fontSize: '10px',
  lineHeight: 1.5,
};

const caveatStyle: React.CSSProperties = {
  marginTop: 3,
  color: AMBER,
  fontSize: '10px',
  lineHeight: 1.4,
};
