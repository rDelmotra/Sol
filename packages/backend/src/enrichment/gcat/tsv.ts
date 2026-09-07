// ============================================================
// tsv.ts — generic parser for GCAT's true-TSV files (launch.tsv, orgs.tsv,
// lv.tsv, sites.tsv, …). Distinct from the fixed-width object catalogs
// (fixed-width.ts): these are tab-separated with a '#'-prefixed header line
// and '# Updated …' / '# section' comment lines.
//
// Shape:
//   #Launch_Tag\tLaunch_JD\t…      ← header; leading '#' stripped from col 1
//   # Updated 2026 Jul  3 2202:54  ← comment (skipped; snapshot extracted)
//   1942-A01\t2430523.95\t…        ← data rows
// ============================================================

export interface GcatTsv {
  snapshotDate: string | null;
  columns: string[];
  rows: Record<string, string>[];
}

/**
 * Parse a GCAT TSV. Cells are trimmed; '-' (GCAT's missing marker) → ''.
 * The first '#'-prefixed line is the header — its leading '#' is stripped so
 * consumers read clean keys (row.Launch_Tag, row.Code, …).
 */
export function parseGcatTsv(text: string): GcatTsv {
  const lines = text.split(/\r?\n/);

  let columns: string[] | null = null;
  let snapshotDate: string | null = null;
  const rows: Record<string, string>[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!columns) {
        columns = line.slice(1).split('\t').map((c) => c.trim());
      } else if (!snapshotDate && line.startsWith('# Updated')) {
        snapshotDate = line.slice('# Updated'.length).trim() || null;
      }
      continue;
    }
    if (!columns) continue; // junk before the header
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    for (let i = 0; i < columns.length; i++) {
      const v = (cells[i] ?? '').trim();
      row[columns[i]] = v === '-' ? '' : v;
    }
    rows.push(row);
  }

  if (!columns) throw new Error('GCAT TSV parse: no #-prefixed header line found');
  return { snapshotDate, columns, rows };
}
