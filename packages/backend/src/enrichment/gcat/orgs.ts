// ============================================================
// orgs.ts — GCAT organisations/orgs.tsv → OrgRecord map
//
// The Organizations entity (G2). Org Class (B/D/C/A) is the sector authority
// for the Owner→org join in inherit.ts — a SOURCE join, not inference.
// Columns: Code UCode StateCode Type Class TStart TStop ShortName Name
//          Location Longitude Latitude Error Parent ShortEName EName UName
// Docs: https://planet4589.org/space/gcat/web/orgs/
// ============================================================

import type { Sector } from '../types.js';
import { parseGcatTsv } from './tsv.js';
import { clasToSectors } from './vocab.js';

export interface OrgRecord {
  code: string;
  name: string;               // display pick: EName || ShortEName || ShortName || Name
  stateCode: string | null;   // GCAT state code (canonicalize at use sites)
  cls: string | null;         // raw Class (B/D/C/A)
  sectors: Sector[];          // Class folded like psatcat Clas (A→civil)
  type: string | null;        // raw Type flags ("O/PL", "LA", …)
  parent: string | null;      // org hierarchy (another org code)
  lat: number | null;
  lon: number | null;
  tstart: string | null;
  tstop: string | null;
}

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
    out.set(row.Code, {
      code: row.Code,
      name: row.EName || row.ShortEName || row.ShortName || row.Name || row.Code,
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
