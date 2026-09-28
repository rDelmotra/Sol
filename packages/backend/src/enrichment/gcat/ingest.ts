// ============================================================
// ingest.ts — GCAT satcat + psatcat → ObjectMetadata records
//
// The census pass of build-enrichment.ts (runs FIRST; UCS overlays after with
// only-empty fills). Pure text-in/records-out — callers read the files — so
// the whole pass is unit-testable on synthetic fixtures.
//
// Contracts (my_plans/architecture.audit.reports/gcat_ingestion_architecture.md + G1 plan):
//  • NORAD-keyed: only rows with a numeric Satcat enter the map. JCAT/COSPAR
//    are stored as fields for later entity joins (G2 launches/orgs).
//  • Raw preserved: every normalized facet keeps its verbatim source cell in
//    rec.gcat (GcatRawCodes) — reversible without re-reading the snapshot.
//  • Nothing folds silently: unmapped codes go to 'unknown'/pass-through AND
//    are counted in the MappingReport (committed as gcat-mapping-report.json).
//  • Owner/Manufacturer org CODES are raw-block only — operatorOrg keeps its
//    UCS/inferred display-name sources until G2 resolves orgs.tsv.
// ============================================================

import {
  DecayedCatalogRow,
  FacetProvenance,
  GcatRawCodes,
  ObjectMetadata,
  OrbitalStatus,
} from '@orbitwatch/contracts';
import { emptyObjectMetadata } from '../types.js';
import {
  canonicalFromSatcatState,
  SATCAT_STATE_TO_CANONICAL,
} from '../country-codes.js';
import { parseGcatCatalog, cleanCode, cleanNum, yearOf } from './fixed-width.js';
import { lookupGcatStatus, lookupGcatType, clasToSectors, categoryToPurpose } from './vocab.js';

// ── Mapping report — the "every ambiguity surfaced" contract ─────────────────

export interface NoradCollision {
  norad: number;
  kept: string;    // JCAT of the surviving row
  dropped: string; // JCAT of the discarded row
}

export interface MappingReport {
  unmappedStatus: Record<string, number>;
  unmappedType: Record<string, number>;
  unmappedClas: Record<string, number>;      // per unknown Clas character
  unmappedCategory: Record<string, number>;  // per unknown primary token
  passthroughStateCodes: Record<string, number>; // state codes not in the canonical table
  noradCollisions: NoradCollision[];
  skippedNoNorad: number;    // satcat rows with NNA/NSO/blank Satcat
  psatcatUnjoined: number;   // psatcat rows whose JCAT has no NORAD-keyed satcat row
}

export function emptyMappingReport(): MappingReport {
  return {
    unmappedStatus: {},
    unmappedType: {},
    unmappedClas: {},
    unmappedCategory: {},
    passthroughStateCodes: {},
    noradCollisions: [],
    skippedNoNorad: 0,
    psatcatUnjoined: 0,
  };
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

const DECAYED_STATUSES = new Set<OrbitalStatus>(['decayed', 'deorbited', 'exploded']);

export interface GcatIngestResult {
  snapshotDate: string | null;
  report: MappingReport;
  /** JCAT → NORAD over the CHOSEN (deduped) satcat rows — used by the G2
   *  parent walk in inherit.ts to resolve rec.parentJcat references. */
  jcatToNorad: Map<string, number>;
}

// ── The ingest pass ───────────────────────────────────────────────────────────

export function ingestGcat(
  satcatText: string,
  psatcatText: string,
  map: Map<number, ObjectMetadata>,
  decayedOut: DecayedCatalogRow[],
  namesOut: Map<number, string>,
): GcatIngestResult {
  const report = emptyMappingReport();
  const satcat = parseGcatCatalog(satcatText);
  const psatcat = parseGcatCatalog(psatcatText);

  // 1) Select ONE satcat row per NORAD. Renamed objects ('N' = superseded
  //    record) can share a NORAD with their successor; prefer the non-N row,
  //    then the later JCAT. 10 collisions in the 2026-07 snapshot — all logged.
  const chosen = new Map<number, Record<string, string>>();
  for (const row of satcat.rows) {
    const satcatCell = row.Satcat ?? '';
    if (!/^\d+$/.test(satcatCell)) {
      report.skippedNoNorad++;
      continue;
    }
    const norad = parseInt(satcatCell, 10);
    const prev = chosen.get(norad);
    if (!prev) {
      chosen.set(norad, row);
      continue;
    }
    const keep = pickSatcatRow(prev, row);
    const drop = keep === prev ? row : prev;
    report.noradCollisions.push({ norad, kept: keep.JCAT, dropped: drop.JCAT });
    chosen.set(norad, keep);
  }

  // 2) Build records + the JCAT→NORAD index for the psatcat overlay.
  const jcatToNorad = new Map<string, number>();
  for (const [norad, row] of chosen) {
    jcatToNorad.set(row.JCAT, norad);
    const rec = map.get(norad) ?? emptyObjectMetadata(norad);
    applySatcatRow(rec, row, report);
    map.set(norad, rec);

    const name = row.Name?.trim();
    if (name) namesOut.set(norad, name);

    if (DECAYED_STATUSES.has(rec.orbitalStatus)) {
      decayedOut.push({
        noradId: norad,
        name: name || `NORAD ${norad}`,
        country: rec.operatorCountry,
        status: rec.orbitalStatus,
        objectType: rec.objectType,
        orbitClass: rec.orbitClass,
        launchYear: yearOf(row.LDate?.trim() || null),
      });
    }
  }

  // 3) psatcat overlay — payload facets, joined by JCAT.
  for (const row of psatcat.rows) {
    const norad = jcatToNorad.get(row.JCAT);
    if (norad === undefined) {
      report.psatcatUnjoined++;
      continue;
    }
    applyPsatcatRow(map.get(norad)!, row, report);
  }

  return { snapshotDate: satcat.snapshotDate, report, jcatToNorad };
}

/** Collision rule: prefer the non-superseded ('N' = renamed) row, then later JCAT. */
function pickSatcatRow(
  a: Record<string, string>,
  b: Record<string, string>,
): Record<string, string> {
  const aN = a.Status?.trim() === 'N';
  const bN = b.Status?.trim() === 'N';
  if (aN !== bN) return aN ? b : a;
  return b.JCAT > a.JCAT ? b : a;
}

// ── satcat row → record ───────────────────────────────────────────────────────

function applySatcatRow(
  rec: ObjectMetadata,
  row: Record<string, string>,
  report: MappingReport,
): void {
  const raw: GcatRawCodes = {};
  const prov: FacetProvenance = {};

  rec.jcat = row.JCAT;

  const launchTag = cleanCode(row.Launch_Tag).value;
  if (launchTag) rec.launchTag = launchTag;
  const launchDate = cleanCode(row.LDate).value;
  if (launchDate) rec.launchDate = launchDate;
  const piece = cleanCode(row.Piece).value;
  if (piece) rec.cospar = piece;

  // Separation-tree parent. First token only (cells may carry a port suffix,
  // e.g. "S25545 PMA-1"), '*' (mismatch flag) stripped; JCAT references only —
  // world names (Earth/Luna) live in the Primary column, but guard anyway.
  const parentCell = row.Parent?.trim() ?? '';
  if (parentCell && parentCell !== '-') {
    raw.parent = parentCell;
    const tok = parentCell.split(/\s+/)[0].replace(/\*$/, '');
    if (/^[A-Z]\d/.test(tok)) rec.parentJcat = tok;
  }

  // Orbital status — doc-verified table; unmapped → 'unknown' + reported.
  const statusRaw = row.Status?.trim() ?? '';
  if (statusRaw) raw.status = statusRaw;
  const status = lookupGcatStatus(statusRaw || null);
  if (status) {
    rec.orbitalStatus = status;
  } else {
    rec.orbitalStatus = 'unknown';
    if (statusRaw) bump(report.unmappedStatus, statusRaw);
  }

  // Object type — first char of the Type cell; full cell preserved raw.
  const typeRaw = row.Type?.trim() ?? '';
  if (typeRaw) raw.type = typeRaw;
  const objectType = lookupGcatType(typeRaw || null);
  if (objectType) {
    rec.objectType = objectType;
  } else {
    rec.objectType = 'unknown';
    if (typeRaw) bump(report.unmappedType, typeRaw[0]);
  }

  // Country — GCAT state code → canonical Space-Track code. Codes outside the
  // table pass through raw (displayCountry falls back to the code) + reported.
  const state = cleanCode(row.State).value;
  if (state) {
    raw.state = row.State.trim();
    rec.operatorCountry = canonicalFromSatcatState(state);
    prov.country = 'gcat';
    if (!(state in SATCAT_STATE_TO_CANONICAL)) bump(report.passthroughStateCodes, state);
  }

  // Owner / Manufacturer org CODES — raw block only (G2 resolves names).
  const owner = cleanCode(row.Owner).value;
  if (owner) raw.owner = row.Owner.trim();
  const manufacturer = cleanCode(row.Manufacturer).value;
  if (manufacturer) raw.manufacturer = row.Manufacturer.trim();

  // Orbit class — first token of the merged "OpOrbitOQU" cell ("LLEO/I -").
  const opOrbitCell = row.OpOrbitOQU?.trim() ?? '';
  if (opOrbitCell && opOrbitCell !== '-') {
    raw.opOrbit = opOrbitCell;
    const firstTok = opOrbitCell.split(/\s+/)[0];
    if (firstTok && firstTok !== '-') rec.orbitClass = firstTok;
  }

  // Masses / dimensions — GCAT Mass = launch mass (cols doc); 0 = unknown.
  const mass = cleanNum(row.Mass);
  if (mass) rec.launchMassKg = mass;
  const dryMass = cleanNum(row.DryMass);
  if (dryMass) rec.dryMassKg = dryMass;
  const totMass = cleanNum(row.TotMass);
  if (totMass) rec.totMassKg = totMass;
  const lengthM = cleanNum(row.Length);
  if (lengthM) rec.lengthM = lengthM;
  const diameterM = cleanNum(row.Diamete ?? row.Diameter);
  if (diameterM) rec.diameterM = diameterM;
  const spanM = cleanNum(row.Span);
  if (spanM) rec.spanM = spanM;

  const bus = cleanCode(row.Bus).value;
  if (bus) rec.bus = bus;
  const motor = cleanCode(row.Motor).value;
  if (motor) rec.motor = motor;
  const shape = cleanCode(row.Shape).value;
  if (shape) rec.shape = shape;

  attach(rec, raw, prov);
  if (!rec.sources.includes('gcat')) rec.sources.push('gcat');
}

// ── psatcat row → payload overlay ─────────────────────────────────────────────

function applyPsatcatRow(
  rec: ObjectMetadata,
  row: Record<string, string>,
  report: MappingReport,
): void {
  const raw: GcatRawCodes = {};
  const prov: FacetProvenance = {};

  // Sectors from Clas (B/D/C/A per char).
  const clasCell = row.Clas?.trim() ?? '';
  const clas = cleanCode(clasCell).value;
  if (clas) {
    raw.clas = clasCell;
    const { sectors, unknownChars } = clasToSectors(clas);
    for (const ch of unknownChars) bump(report.unmappedClas, ch);
    if (sectors.length > 0) {
      rec.sectors = sectors;
      prov.sectors = 'gcat';
    }
  }

  // Purpose from Category (primary token; explicit 'other' buckets are mapped).
  const categoryCell = row.Category?.trim() ?? '';
  const category = cleanCode(categoryCell).value;
  if (category) {
    raw.category = categoryCell;
    const purpose = categoryToPurpose(category);
    if (purpose) {
      rec.purpose = purpose;
      prov.purpose = 'gcat';
    } else {
      bump(report.unmappedCategory, category.split('/')[0]?.replace(/[?*]/g, '') ?? category);
    }
    // Raw category doubles as detailed purpose until UCS's curated text (if
    // any) overwrites it in the UCS pass.
    if (!rec.detailedPurpose) rec.detailedPurpose = categoryCell;
  }

  // Program string — raw; the registry-slug mapping happens in applyPrograms.
  const program = cleanCode(row.Program).value;
  if (program) {
    raw.program = row.Program.trim();
    rec.gcatProgram = program;
  }

  // Maneuverability (Mvr: M/D) — NOT visual magnitude (header reads "Mv").
  const mvr = cleanCode(row.Mv).value;
  if (mvr === 'M' || mvr === 'D') rec.maneuverability = mvr;

  const att = cleanCode(row.At).value;
  if (att) rec.attitudeControl = att;
  const plane = cleanCode(row.Plane).value;
  if (plane) rec.plane = plane;

  // Operational timeline. '*' = "believed still active/operating/transmitting"
  // → field omitted; real vague dates kept raw.
  const tLast = row.TLast?.trim() ?? '';
  const tOp = row.TOp?.trim() ?? '';
  const tDate = row.TDate?.trim() ?? '';
  if (tLast && tLast !== '*' && tLast !== '-') rec.lastActiveDate = tLast;
  if (tOp && tOp !== '*' && tOp !== '-') rec.endOpDate = tOp;
  if (tDate && tDate !== '*' && tDate !== '-') rec.endTransmitDate = tDate;

  // Operational status — the axis Space-Track never provided:
  //   TOp='*' (believed still operating) → operational
  //   TF='Z' (zombie: beacon only)       → nonoperational
  //   a real end-of-ops/transmission date → nonoperational
  const tf = cleanCode(row.TF).value;
  if (tOp === '*') rec.operationalStatus = 'operational';
  else if (tf === 'Z') rec.operationalStatus = 'nonoperational';
  else if (rec.endOpDate || rec.endTransmitDate) rec.operationalStatus = 'nonoperational';

  attach(rec, raw, prov);
}

/** Merge raw codes + provenance onto the record — never assigning empty {}. */
function attach(rec: ObjectMetadata, raw: GcatRawCodes, prov: FacetProvenance): void {
  if (Object.keys(raw).length > 0) rec.gcat = { ...rec.gcat, ...raw };
  if (Object.keys(prov).length > 0) rec.facetProvenance = { ...rec.facetProvenance, ...prov };
}
