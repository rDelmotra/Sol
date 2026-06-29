// ============================================================
// build-enrichment.ts — one-shot metadata join builder (SKELETON)
//
// Reads the two static snapshots (McDowell General Catalog + UCS Satellite
// Database), normalizes each to ObjectMetadata, unions them keyed by NORAD ID,
// and writes packages/backend/data/metadata-enrichment.json.
//
// Run manually on snapshot refresh — NOT on the request path, NOT at boot:
//   npx tsx packages/backend/src/enrichment/build-enrichment.ts
//
// Today this is a compilable skeleton: the parse + normalize seams are stubbed
// with TODOs. Wire the actual field mapping in the enrichment phase.
// See my_plans/metadata_enrichment.md §4.
// ============================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ObjectMetadata,
  Sector,
  Purpose,
  OrbitalStatus,
  CatalogObjectType,
  UCS_USER_TO_SECTOR,
  SATCAT_STATUS_TO_ORBITAL,
  SATCAT_TYPE_TO_OBJECT,
} from './types.js';
import { canonicalFromSatcatState, canonicalFromUcsCountry } from './country-codes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const SATCAT_CSV = resolve(REPO_ROOT, 'my_plans/satcat.csv');
const UCS_TXT = resolve(REPO_ROOT, 'my_plans/UCS-Satellite-Database 5-1-2023 (text).txt');
const OUT_JSON = resolve(__dirname, '../../data/metadata-enrichment.json');

// ── Minimal parsers (no deps) ─────────────────────────────────────────────────

/** Parse a delimited line, honoring simple double-quote escaping. */
function parseDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function toNum(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function emptyRecord(noradId: number): ObjectMetadata {
  return {
    noradId,
    operatorCountry: null,
    operatorOrg: null,
    sectors: [],
    purpose: 'other',
    detailedPurpose: null,
    operationalStatus: 'unknown',
    orbitalStatus: 'unknown',
    objectType: 'unknown',
    contractor: null,
    contractorCountry: null,
    launchSite: null,
    launchVehicle: null,
    launchMassKg: null,
    dryMassKg: null,
    powerW: null,
    expectedLifetimeYrs: null,
    cospar: null,
    orbitClass: null,
    sources: [],
  };
}

// ── Normalizers ───────────────────────────────────────────────────────────────

/** "Military/Government" → ['military','government']; unknown tokens dropped. */
function parseSectors(usersCell: string): Sector[] {
  const out: Sector[] = [];
  for (const tok of usersCell.split('/')) {
    const s = UCS_USER_TO_SECTOR[tok.trim()];
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** UCS free-text Purpose → normalized Purpose enum (primary token). */
function parsePurpose(cell: string): Purpose {
  const p = cell.split('/')[0]?.trim().toLowerCase() ?? '';
  if (p.startsWith('communications')) return 'communications';
  if (p.startsWith('earth observation')) return 'earth_observation';
  if (p.startsWith('earth science')) return 'earth_observation';
  if (p.startsWith('navigation')) return 'navigation';
  if (p.startsWith('technology')) return 'technology_dev';
  if (p.startsWith('space science')) return 'space_science';
  if (p.startsWith('space observation')) return 'space_observation';
  if (p.startsWith('surveillance')) return 'surveillance';
  if (p.startsWith('meteorolog')) return 'meteorological';
  return 'other';
}

// ── Source ingest ───────────────────────────────────────────────────────────

/** Ingest satcat.csv → seed records keyed by NORAD (country, status, type, orbit_class). */
function ingestSatcat(map: Map<number, ObjectMetadata>): void {
  const text = readFileSync(SATCAT_CSV, 'utf-8');
  const lines = text.split(/\r?\n/);
  const header = parseDelimited(lines[0], ',');
  const idx = (name: string) => header.indexOf(name);
  const iNorad = idx('satcat');
  const iState = idx('state');
  const iOwner = idx('owner');
  const iStatus = idx('status');
  const iType = idx('object_type');
  const iClass = idx('orbit_class');

  for (let r = 1; r < lines.length; r++) {
    if (!lines[r]) continue;
    const f = parseDelimited(lines[r], ',');
    const norad = parseInt(f[iNorad], 10);
    if (!Number.isFinite(norad)) continue;

    const rec = map.get(norad) ?? emptyRecord(norad);
    rec.operatorCountry = canonicalFromSatcatState(f[iState]?.trim() ?? '');
    rec.operatorOrg = f[iOwner]?.trim() || null;
    rec.orbitalStatus = (SATCAT_STATUS_TO_ORBITAL[f[iStatus]?.trim()] ?? 'unknown') as OrbitalStatus;
    rec.objectType = (SATCAT_TYPE_TO_OBJECT[f[iType]?.trim()] ?? 'unknown') as CatalogObjectType;
    rec.orbitClass = f[iClass]?.trim() || null;
    if (!rec.sources.includes('satcat-gc')) rec.sources.push('satcat-gc');
    map.set(norad, rec);
  }
}

/** Ingest the UCS database → overlay sector/purpose/specs (active payloads only). */
function ingestUcs(map: Map<number, ObjectMetadata>): void {
  // NOTE: the .txt is single-byte (latin-1), tab-separated. 'latin1' is lossless here.
  const text = readFileSync(UCS_TXT, 'latin1');
  const lines = text.split(/\r?\n/);
  const header = parseDelimited(lines[0], '\t').map((c) => c.trim());
  const idx = (name: string) => header.indexOf(name);
  const iNorad = idx('NORAD Number');
  const iUsers = idx('Users');
  const iPurpose = idx('Purpose');
  const iDetail = idx('Detailed Purpose');
  const iCountry = idx('Country of Operator/Owner');
  const iOperator = idx('Operator/Owner');
  const iContractor = idx('Contractor');
  const iContractorCountry = idx('Country of Contractor');
  const iSite = idx('Launch Site');
  const iVehicle = idx('Launch Vehicle');
  const iLaunchMass = idx('Launch Mass (kg.)');
  const iDryMass = idx('Dry Mass (kg.)');
  const iPower = idx('Power (watts)');
  const iLifetime = idx('Expected Lifetime (yrs.)');
  const iCospar = idx('COSPAR Number');

  for (let r = 1; r < lines.length; r++) {
    if (!lines[r]) continue;
    const f = parseDelimited(lines[r], '\t');
    const norad = parseInt(f[iNorad]?.trim() ?? '', 10);
    if (!Number.isFinite(norad)) continue;

    const rec = map.get(norad) ?? emptyRecord(norad);
    rec.sectors = parseSectors(f[iUsers] ?? '');
    rec.purpose = parsePurpose(f[iPurpose] ?? '');
    rec.detailedPurpose = f[iDetail]?.trim() || null;
    // UCS country is the live-authority fallback only if Space-Track later has none.
    if (!rec.operatorCountry) rec.operatorCountry = canonicalFromUcsCountry(f[iCountry] ?? '');
    rec.operatorOrg = rec.operatorOrg ?? (f[iOperator]?.trim() || null);
    rec.contractor = f[iContractor]?.trim() || null;
    rec.contractorCountry = f[iContractorCountry]?.trim() || null;
    rec.launchSite = f[iSite]?.trim() || null;
    rec.launchVehicle = f[iVehicle]?.trim() || null;
    rec.launchMassKg = toNum(f[iLaunchMass]);
    rec.dryMassKg = toNum(f[iDryMass]);
    rec.powerW = toNum(f[iPower]);
    rec.expectedLifetimeYrs = toNum(f[iLifetime]);
    rec.cospar = f[iCospar]?.trim() || null;
    if (!rec.sources.includes('ucs-2023-05')) rec.sources.push('ucs-2023-05');
    map.set(norad, rec);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const map = new Map<number, ObjectMetadata>();
  ingestSatcat(map);
  ingestUcs(map);

  const out: Record<number, ObjectMetadata> = {};
  for (const [norad, rec] of map) out[norad] = rec;

  writeFileSync(OUT_JSON, JSON.stringify(out));
  // eslint-disable-next-line no-console
  console.log(`metadata-enrichment.json written: ${map.size} records → ${OUT_JSON}`);
}

// Run only when invoked directly (tsx), never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
