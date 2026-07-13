// ============================================================
// fixed-width.ts — parser for GCAT object-catalog files (satcat, psatcat, …)
//
// The cats/ downloads are the site's HTML display format, NOT TSVs:
//
//   line 1: <meta http-equiv=...>          ← HTML junk
//   line 2: <PRE>
//   line 3: JCAT   Satcat   Launch_Tag …    ← space-padded fixed-width header
//   line 4: </PRE>
//   line 5: # Updated 2026 Jul  3 2203:53   ← snapshot timestamp
//   line 6: <PRE>
//   line 7…: data rows                      ← space-padded fixed-width
//   last:  </PRE>
//
// Column START offsets are derived from the header line at parse time — they
// shift between snapshots as name widths change, so they are NEVER hardcoded.
// Field i spans [offset_i, offset_{i+1}); the last field runs to end-of-line.
//
// Cell conventions (see my_plans/architecture.audit.reports/gcat_ingestion_architecture.md §1):
//   '-' or ''      → missing
//   trailing '?'   → uncertainty flag, INSIDE the cell ("2000  ?", "GSFC?")
//   vague dates    → "1998 Nov 20 0649:47" with varying precision; kept raw
// ============================================================

export interface GcatCatalog {
  /** From the "# Updated …" line; null if absent. */
  snapshotDate: string | null;
  /** Header column names in file order (e.g. "Diamete", "OpOrbitOQU" verbatim). */
  columns: string[];
  /** One record per data row — column name → raw trimmed cell text. */
  rows: Record<string, string>[];
}

/** First cell must look like a JCAT id (S00001, A11915, D01206, …). */
const JCAT_ROW = /^[A-Z]\d/;

/**
 * Parse one GCAT catalog file (full text). Throws if no header line is found —
 * a malformed download should fail the build loudly, not produce zero rows.
 */
export function parseGcatCatalog(text: string): GcatCatalog {
  const lines = text.split(/\r?\n/);

  let snapshotDate: string | null = null;
  let header: string | null = null;

  // Locate header (first line starting with "JCAT") and the snapshot stamp.
  for (const line of lines) {
    if (!header && line.startsWith('JCAT')) header = line;
    if (!snapshotDate && line.startsWith('# Updated')) {
      snapshotDate = line.slice('# Updated'.length).trim() || null;
    }
    if (header && snapshotDate) break;
  }
  if (!header) throw new Error('GCAT parse: no header line starting with "JCAT" found');

  // Derive [name, startOffset] pairs from the header's non-space runs.
  const cols: { name: string; start: number }[] = [];
  for (const m of header.matchAll(/\S+/g)) {
    cols.push({ name: m[0], start: m.index ?? 0 });
  }
  const columns = cols.map((c) => c.name);

  // Rows must at least reach the second column to be parseable; 57 malformed
  // short lines exist in the 2026-07 snapshot and are skipped here.
  const minLen = cols.length > 1 ? cols[1].start + 1 : 1;

  const rows: Record<string, string>[] = [];
  for (const line of lines) {
    if (!line || line.startsWith('<') || line.startsWith('#') || line === header) continue;
    if (line.length < minLen || !JCAT_ROW.test(line)) continue;
    const row: Record<string, string> = {};
    for (let i = 0; i < cols.length; i++) {
      const end = i + 1 < cols.length ? cols[i + 1].start : line.length;
      row[cols[i].name] = line.slice(cols[i].start, end).trim();
    }
    rows.push(row);
  }

  return { snapshotDate, columns, rows };
}

// ── Cell cleaning helpers ─────────────────────────────────────────────────────

export interface CleanedCode {
  value: string | null;
  uncertain: boolean;
}

/** '-'/'' → null; strip ONE trailing '?' (uncertainty flag) off code cells. */
export function cleanCode(cell: string | undefined): CleanedCode {
  const t = (cell ?? '').trim();
  if (t === '' || t === '-') return { value: null, uncertain: false };
  if (t.endsWith('?')) {
    const v = t.slice(0, -1).trim();
    return { value: v === '' || v === '-' ? null : v, uncertain: true };
  }
  return { value: t, uncertain: false };
}

/**
 * Numeric cell → number|null. Strips embedded '?' flags ("2000  ?"); callers
 * decide whether 0 means missing (it does for GCAT masses/dimensions).
 */
export function cleanNum(cell: string | undefined): number | null {
  const t = (cell ?? '').replace(/\?/g, '').trim();
  if (t === '' || t === '-') return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** Extract the 4-digit year from a GCAT vague date ("1998 Nov 20 0649:47"). */
export function yearOf(vagueDate: string | null): number | null {
  if (!vagueDate) return null;
  const m = vagueDate.match(/\b(\d{4})\b/);
  return m ? parseInt(m[1], 10) : null;
}
