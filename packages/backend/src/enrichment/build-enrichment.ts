// ============================================================
// build-enrichment.ts — one-shot metadata join builder
//
// Reads the two static snapshots (the full GCAT satcat+psatcat + the UCS
// Satellite Database), normalizes each to ObjectMetadata, unions them keyed by
// NORAD ID, and writes the committed runtime artifacts:
//   enrichment-data/metadata-enrichment.json  — { meta, objects } full join
//   enrichment-data/decayed-catalog.json      — { meta, rows } decayed browser
//   enrichment-data/gcat-mapping-report.json  — every unmapped code/collision
//   enrichment-data/programs-summary.json     — registry roll-up
//
// Precedence per facet: GCAT (measured, maintained) > UCS (frozen 2023-05) >
// program inference — EXCEPT the free-text dossier fields UCS uniquely curates
// (detailed purpose text, power, lifetime, sites/vehicles as display names).
//
// Run manually on snapshot refresh — NOT on the request path, NOT at boot:
//   npx tsx packages/backend/src/enrichment/build-enrichment.ts
//
// Output lands in packages/backend/enrichment-data/ (committed, NOT the gitignored
// runtime data/ dir) so it ships to prod and the loader resolves it identically
// under tsx (dev) and node dist (prod). See my_plans/metadata_enrichment.md §4
// and my_plans/gcat_ingestion_architecture.md.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ObjectMetadata,
  DecayedCatalogRow,
  Sector,
  Purpose,
  EnrichmentArtifactMeta,
  UCS_USER_TO_SECTOR,
  emptyObjectMetadata,
} from './types.js';
import { canonicalFromUcsCountry } from './country-codes.js';
import { PROGRAMS, matchProgram, applyProgramDefaults } from './programs.js';
import { ingestGcat } from './gcat/ingest.js';
import { parseGcatOrgs, OrgRecord } from './gcat/orgs.js';
import {
  parseGcatLaunches,
  parseLvFamilies,
  parseSiteNames,
  LaunchRecord,
} from './gcat/launches.js';
import { applyGraphInheritance } from './gcat/inherit.js';
import { buildQueryVocab } from './query-vocab.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const GCAT_DIR = resolve(REPO_ROOT, 'my_plans/GCAT all');
const GCAT_SATCAT = resolve(GCAT_DIR, 'Object catalog/cats/satcat');
const GCAT_PSATCAT = resolve(GCAT_DIR, 'Object catalog/cats/psatcat');
const GCAT_ORGS = resolve(GCAT_DIR, 'organisations/orgs.tsv');
const GCAT_LAUNCH = resolve(GCAT_DIR, 'Launch Lists/launch.tsv');
const GCAT_LV = resolve(GCAT_DIR, 'Launch Vehicles/lv.tsv');
const GCAT_SITES = resolve(GCAT_DIR, 'Launch Origin/sites.tsv');
const UCS_TXT = resolve(REPO_ROOT, 'my_plans/UCS-Satellite-Database 5-1-2023 (text).txt');
// Committed artifact dir — anchored at the backend package root (../../enrichment-data),
// resolving the same under src (tsx) and dist (node), mirroring how file-cache.ts anchors data/.
const GEN_DIR = resolve(__dirname, '../../enrichment-data');
const OUT_JSON = resolve(GEN_DIR, 'metadata-enrichment.json');
const OUT_DECAYED = resolve(GEN_DIR, 'decayed-catalog.json');
const OUT_PROGRAMS = resolve(GEN_DIR, 'programs-summary.json');
const OUT_REPORT = resolve(GEN_DIR, 'gcat-mapping-report.json');
const OUT_LAUNCHES = resolve(GEN_DIR, 'launches.json');
const OUT_ORGS = resolve(GEN_DIR, 'orgs.json');
const OUT_VOCAB = resolve(GEN_DIR, 'query-vocab.json');

const GCAT_CITATION = 'GCAT (J. McDowell, planet4589.org/space/gcat)';
const UCS_SNAPSHOT = '2023-05-01';

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

/**
 * Ingest the UCS database → overlay specs (active payloads only). Runs AFTER
 * the GCAT pass: sectors/purpose/country/masses fill ONLY when GCAT left them
 * empty; the UCS-unique dossier fields (detailed purpose text, contractor,
 * site/vehicle display names, power, lifetime) keep UCS authority.
 */
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

    const rec = map.get(norad) ?? emptyObjectMetadata(norad);
    // GCAT wins on shared facets — UCS fills only-empty (psatcat Clas/Category
    // cover ~all payloads, so these fire mainly for objects GCAT skipped).
    if (rec.sectors.length === 0) rec.sectors = parseSectors(f[iUsers] ?? '');
    // 'other' sourced from GCAT (prov stamp) is a statement, not a gap — keep it.
    if (rec.purpose === 'other' && rec.facetProvenance?.purpose !== 'gcat') {
      const p = parsePurpose(f[iPurpose] ?? '');
      if (p !== 'other') rec.purpose = p;
    }
    // UCS's curated English text beats the raw GCAT category string when present.
    const detail = f[iDetail]?.trim();
    if (detail) rec.detailedPurpose = detail;
    if (!rec.operatorCountry) rec.operatorCountry = canonicalFromUcsCountry(f[iCountry] ?? '');
    rec.operatorOrg = rec.operatorOrg ?? (f[iOperator]?.trim() || null);
    rec.contractor = f[iContractor]?.trim() || null;
    rec.contractorCountry = f[iContractorCountry]?.trim() || null;
    rec.launchSite = f[iSite]?.trim() || null;
    rec.launchVehicle = f[iVehicle]?.trim() || null;
    rec.launchMassKg = rec.launchMassKg ?? toNum(f[iLaunchMass]);
    rec.dryMassKg = rec.dryMassKg ?? toNum(f[iDryMass]);
    rec.powerW = toNum(f[iPower]);
    rec.expectedLifetimeYrs = toNum(f[iLifetime]);
    rec.cospar = rec.cospar ?? (f[iCospar]?.trim() || null);
    if (!rec.sources.includes('ucs-2023-05')) rec.sources.push('ucs-2023-05');
    map.set(norad, rec);
  }
}

// ── Program slug pass ─────────────────────────────────────────────────────────

interface CoverageStats {
  sectors: number;
  purpose: number;
  program: number;
  mass: number;
  bus: number;
  total: number;
}

/** Live in-orbit coverage — the numbers the enrichment passes move. */
function coverageStats(
  map: Map<number, ObjectMetadata>,
  scope: 'payloads' | 'all' = 'payloads',
): CoverageStats {
  const s: CoverageStats = { sectors: 0, purpose: 0, program: 0, mass: 0, bus: 0, total: 0 };
  for (const rec of map.values()) {
    if (rec.orbitalStatus !== 'in_orbit') continue;
    if (scope === 'payloads' && rec.objectType !== 'payload') continue;
    s.total++;
    if (rec.sectors.length > 0) s.sectors++;
    // purpose counts as covered when stated OR explicitly sourced/inherited 'other'
    if (rec.purpose !== 'other' || rec.facetProvenance?.purpose !== undefined) s.purpose++;
    if (rec.program) s.program++;
    if (rec.launchMassKg) s.mass++;
    if (rec.bus) s.bus++;
  }
  return s;
}

/**
 * Stamp the registry SLUG on payloads. The GCAT program string is tried first
 * ("Starlink 2MO S1" prefix-matches the starlink entry; GLONASS's GCAT program
 * escapes the ambiguous Kosmos name), then the object name. Facet-filling from
 * registry defaults still applies (only-empty — GCAT/UCS values survive), which
 * after G1 mainly matters for post-snapshot launches via the live cron path.
 * Returns per-program counts + the top unmapped GCAT program strings (registry
 * curation candidates) for the mapping report.
 */
function applyPrograms(
  map: Map<number, ObjectMetadata>,
  names: Map<number, string>,
): { counts: Map<string, number>; unmappedGcatPrograms: [string, number][] } {
  const counts = new Map<string, number>();
  const unmapped = new Map<string, number>();

  for (const rec of map.values()) {
    if (rec.objectType !== 'payload') continue;
    const name = names.get(rec.noradId);
    const entry =
      (rec.gcatProgram ? matchProgram(rec.gcatProgram) : null) ??
      (name ? matchProgram(name) : null);
    if (entry) {
      applyProgramDefaults(rec, entry);
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    } else if (rec.orbitalStatus === 'in_orbit' && rec.gcatProgram) {
      unmapped.set(rec.gcatProgram, (unmapped.get(rec.gcatProgram) ?? 0) + 1);
    }
  }

  const unmappedGcatPrograms = [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  return { counts, unmappedGcatPrograms };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const map = new Map<number, ObjectMetadata>();
  const decayed: DecayedCatalogRow[] = [];
  const names = new Map<number, string>();

  const { snapshotDate, report, jcatToNorad } = ingestGcat(
    readFileSync(GCAT_SATCAT, 'utf-8'),
    readFileSync(GCAT_PSATCAT, 'utf-8'),
    map,
    decayed,
    names,
  );
  const afterGcat = coverageStats(map);
  ingestUcs(map);
  const { counts: programCounts, unmappedGcatPrograms } = applyPrograms(map, names);

  // ── G2: entities + graph inheritance ─────────────────────────────────────────
  const orgs = parseGcatOrgs(readFileSync(GCAT_ORGS, 'utf-8'));
  const launches = parseGcatLaunches(
    readFileSync(GCAT_LAUNCH, 'utf-8'),
    parseLvFamilies(readFileSync(GCAT_LV, 'utf-8')),
    parseSiteNames(readFileSync(GCAT_SITES, 'utf-8')),
  );
  const inheritance = applyGraphInheritance(map, jcatToNorad, orgs);

  const final = coverageStats(map);
  const finalAll = coverageStats(map, 'all');

  // Referenced-only entity artifacts: launches any record points at; orgs any
  // record Owns/Manufactures or any shipped launch lists as Agency (+ parent chains).
  const referencedLaunches: Record<string, LaunchRecord> = {};
  const referencedOrgCodes = new Set<string>();
  for (const rec of map.values()) {
    if (rec.launchTag && launches.has(rec.launchTag)) {
      referencedLaunches[rec.launchTag] = launches.get(rec.launchTag)!;
    }
    for (const raw of [rec.gcat?.owner, rec.gcat?.manufacturer]) {
      if (!raw) continue;
      for (const code of raw.split('/')) {
        const c = code.trim().replace(/\?$/, '');
        if (c) referencedOrgCodes.add(c);
      }
    }
  }
  for (const l of Object.values(referencedLaunches)) {
    for (const a of l.agencies) referencedOrgCodes.add(a);
  }
  // Pull in org parent chains (bounded — hierarchy is shallow).
  for (const code of [...referencedOrgCodes]) {
    let cur = orgs.get(code)?.parent ?? null;
    for (let i = 0; cur && i < 6; i++) {
      referencedOrgCodes.add(cur);
      cur = orgs.get(cur)?.parent ?? null;
    }
  }
  const referencedOrgs: Record<string, OrgRecord> = {};
  for (const code of referencedOrgCodes) {
    const o = orgs.get(code);
    if (o) referencedOrgs[code] = o;
  }

  // G3: the client-side query tier's compact vocabulary (served via /api/query/vocab).
  const queryVocab = buildQueryVocab(map.values(), orgs, referencedLaunches);

  const objects: Record<number, ObjectMetadata> = {};
  for (const [norad, rec] of map) objects[norad] = rec;

  // Drop null/empty fields on write — most of the ~60k GCAT-only records have
  // many null spec fields each, so omitting them roughly halves the artifact.
  // The loader/consumers coalesce missing → null/[]/'other'/'unknown'.
  const slim = (_key: string, value: unknown) =>
    value === null || (Array.isArray(value) && value.length === 0) ? undefined : value;

  const meta = (recordCount: number): EnrichmentArtifactMeta => ({
    source: GCAT_CITATION,
    license: 'CC-BY 4.0',
    gcatSnapshot: snapshotDate,
    ucsSnapshot: UCS_SNAPSHOT,
    builtAt: new Date().toISOString(),
    recordCount,
  });

  // Tiny, diff-reviewable registry roll-up (future GET /api/programs backing).
  const programsSummary = PROGRAMS.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    matchCount: programCounts.get(p.id) ?? 0,
  }));

  // The "measurable + every ambiguity surfaced" contract — committed and
  // diff-reviewed on every snapshot refresh.
  const mappingReport = {
    meta: meta(map.size),
    coverage: {
      liveInOrbitPayloads: final.total,
      afterGcat: { sectors: afterGcat.sectors, purpose: afterGcat.purpose },
      final,
      allInOrbit: finalAll,
    },
    ...report,
    unmappedGcatPrograms: Object.fromEntries(unmappedGcatPrograms),
    inheritance,
  };

  mkdirSync(GEN_DIR, { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify({ meta: meta(map.size), objects }, slim));
  writeFileSync(OUT_DECAYED, JSON.stringify({ meta: meta(decayed.length), rows: decayed }, slim));
  writeFileSync(OUT_PROGRAMS, JSON.stringify(programsSummary, null, 2));
  writeFileSync(OUT_REPORT, JSON.stringify(mappingReport, null, 2));
  writeFileSync(
    OUT_LAUNCHES,
    JSON.stringify(
      { meta: meta(Object.keys(referencedLaunches).length), launches: referencedLaunches },
      slim,
    ),
  );
  writeFileSync(
    OUT_ORGS,
    JSON.stringify({ meta: meta(Object.keys(referencedOrgs).length), orgs: referencedOrgs }, slim),
  );
  // Plain stringify — no slim: the launches tuple's nulls are positional data.
  writeFileSync(
    OUT_VOCAB,
    JSON.stringify({ meta: meta(Object.keys(queryVocab.launches).length), ...queryVocab }),
  );

  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
  const reportCounts = (r: Record<string, number>) =>
    Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n]) => `${k}:${n}`).join(' ') || '(none)';
  // eslint-disable-next-line no-console
  console.log(
    `GCAT snapshot: ${snapshotDate}\n` +
      `Enrichment built: ${map.size} metadata records → ${OUT_JSON}\n` +
      `Decayed catalog: ${decayed.length} rows → ${OUT_DECAYED}\n` +
      `Live in-orbit payloads (${final.total}):\n` +
      `  sectors  ${final.sectors} (${pct(final.sectors, final.total)})  ` +
      `purpose ${final.purpose} (${pct(final.purpose, final.total)})  ` +
      `program ${final.program} (${pct(final.program, final.total)})\n` +
      `  mass     ${final.mass} (${pct(final.mass, final.total)})  ` +
      `bus ${final.bus} (${pct(final.bus, final.total)})\n` +
      `ALL in-orbit objects (${finalAll.total}):\n` +
      `  sectors  ${finalAll.sectors} (${pct(finalAll.sectors, finalAll.total)})  ` +
      `purpose ${finalAll.purpose} (${pct(finalAll.purpose, finalAll.total)})  ` +
      `program ${finalAll.program} (${pct(finalAll.program, finalAll.total)})\n` +
      `Entities: ${Object.keys(referencedLaunches).length} launches → ${OUT_LAUNCHES}\n` +
      `          ${Object.keys(referencedOrgs).length} orgs → ${OUT_ORGS}\n` +
      `Query vocab: ${Object.keys(queryVocab.launches).length} launches + ` +
      `${Object.keys(queryVocab.orgs).length} in-orbit owner orgs → ${OUT_VOCAB}\n` +
      `Inheritance: owner-sector ${inheritance.ownerSector}  ` +
      `owner-org-name ${inheritance.ownerOrgName}  parent-walk ${inheritance.parentWalkFills}  ` +
      `launch-majority ${inheritance.launchMajorityFills}\n` +
      `  UNRESOLVED purpose+program: ${inheritance.unresolvedTotal}  ` +
      `sector: ${inheritance.unresolvedSectorTotal}  ` +
      `unmatched owners: ${reportCounts(inheritance.unmatchedOwnerCodes)}\n` +
      `Mapping report → ${OUT_REPORT}\n` +
      `  unmapped status:   ${reportCounts(report.unmappedStatus)}\n` +
      `  unmapped category: ${reportCounts(report.unmappedCategory)}\n` +
      `  unmapped clas:     ${reportCounts(report.unmappedClas)}\n` +
      `  passthrough state: ${reportCounts(report.passthroughStateCodes)}\n` +
      `  NORAD collisions:  ${report.noradCollisions.length}  ` +
      `no-NORAD rows: ${report.skippedNoNorad}  psatcat unjoined: ${report.psatcatUnjoined}\n` +
      `  top unmapped GCAT programs: ${reportCounts(mappingReport.unmappedGcatPrograms)}`,
  );
}

// Run only when invoked directly (tsx), never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
