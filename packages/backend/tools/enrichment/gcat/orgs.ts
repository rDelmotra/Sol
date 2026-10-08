// ============================================================
// orgs.ts — GCAT organisations/orgs.tsv → OrgRecord map
//
// The Organizations entity (G2). Org Class (B/D/C/A) is the sector authority
// for the Owner→org join in inherit.ts — a SOURCE join, not inference.
// Columns: Code UCode StateCode Type Class TStart TStop ShortName Name
//          Location Longitude Latitude Error Parent ShortEName EName UName
// Docs: https://planet4589.org/space/gcat/web/orgs/
// ============================================================

// OrgRecord moved to @orbitwatch/contracts as of C3 (also the wire shape
// served verbatim by GET /api/org/:code) — import it from there.
import type { OrgRecord } from '@orbitwatch/contracts';
import { parseGcatTsv } from './tsv.js';
import { clasToSectors } from './vocab.js';

function num(cell: string): number | null {
  if (!cell) return null;
  const n = parseFloat(cell);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse orgs.tsv. Astronomical-body rows (Type 'AP': EARTH, LUNA, …) are
 * skipped — they are Parent targets in the cats, never Owners/Agencies.
 */
export function parseGcatOrgs(text: string): Map<string, OrgRecord> {
  const { rows } = parseGcatTsv(text);
  const out = new Map<string, OrgRecord>();
  for (const row of rows) {
    if (!row.Code) continue;
    const types = (row.Type ?? '').split('/').filter(Boolean);
    if (types.includes('AP')) continue;
    const name = row.EName || row.ShortEName || row.ShortName || row.Name || row.Code;
    const aliases = [...new Set([row.ShortEName, row.ShortName, row.Name].filter(Boolean))]
      .filter((a) => a !== name);
    out.set(row.Code, {
      code: row.Code,
      name,
      ...(aliases.length > 0 ? { aliases } : {}),
      stateCode: row.StateCode || null,
      cls: row.Class || null,
      sectors: clasToSectors(row.Class || null).sectors,
      type: row.Type || null,
      parent: row.Parent || null,
      lat: num(row.Latitude),
      lon: num(row.Longitude),
      tstart: row.TStart || null,
      tstop: row.TStop || null,
    });
  }
  return out;
}
