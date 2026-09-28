// ============================================================
// inherit.ts — the G2 graph pass: Owner→org join + relational inheritance
//
// Closes the structural gap G1 left: GCAT only classifies PAYLOADS, so debris,
// rocket bodies and components (~14.7k in-orbit) had no sector/purpose/program.
// Three mechanisms, applied to ALL records, strictly only-empty (a stated
// facet — gcat/ucs/inferred — is never overwritten):
//
//   A. Owner→orgs.Class     provenance 'gcat-org'  (a JOIN of two GCAT tables —
//      sector/country/org-name from the owning organization; measured 100 %
//      coverage of the in-orbit unclassed set on the 2026-07 snapshot)
//   B. Parent-JCAT walk     provenance 'inherited' (purpose/program from the
//      nearest ancestor PAYLOAD via the separation tree; A/R-jcat parents are
//      a graceful miss — they live outside the NORAD-keyed map)
//   C. Launch-payload majority  provenance 'inherited' (purpose/program by
//      majority vote among the same launch's classed payloads; deterministic
//      tie-break)
//
// Whatever survives all three lands in the report's unresolved list — the
// explicit "this unknown demands its own plan" contract (expected: single digits).
// ============================================================

import type { AnalyticObjectType, FacetProvenance, ObjectMetadata, Purpose } from '@orbitwatch/contracts';
import type { OrgRecord } from './orgs.js';
import { canonicalFromSatcatState } from '../country-codes.js';

export interface UnresolvedObject {
  norad: number;
  jcat?: string;
  type: AnalyticObjectType;
  reason: string;
}

export interface InheritanceReport {
  ownerSector: number;        // sectors filled via org Class
  ownerCountry: number;
  ownerOrgName: number;
  parentWalkFills: number;    // records that got purpose and/or program from an ancestor
  launchMajorityFills: number;
  unmatchedOwnerCodes: Record<string, number>;
  /** In-orbit records still lacking BOTH purpose and program (capped at 50). */
  unresolved: UnresolvedObject[];
  unresolvedTotal: number;
  /** In-orbit records still without a sector after pass A. */
  unresolvedSectorTotal: number;
}

const IN_ORBIT = 'in_orbit';

/** First owner code of a possibly multi-valued cell ("A/B", "GSFC?"). */
export function primaryOwnerCode(rec: ObjectMetadata): string | null {
  const raw = rec.gcat?.owner;
  if (!raw) return null;
  const code = raw.split('/')[0].trim().replace(/\?$/, '');
  return code || null;
}

function stamp(rec: ObjectMetadata, prov: FacetProvenance, source: 'gcat-org' | 'inherited'): void {
  if (Object.keys(prov).length === 0) return;
  rec.facetProvenance = { ...rec.facetProvenance, ...prov };
  if (!rec.sources.includes(source)) rec.sources.push(source);
}

export function applyGraphInheritance(
  map: Map<number, ObjectMetadata>,
  jcatToNorad: Map<string, number>,
  orgs: Map<string, OrgRecord>,
): InheritanceReport {
  const report: InheritanceReport = {
    ownerSector: 0,
    ownerCountry: 0,
    ownerOrgName: 0,
    parentWalkFills: 0,
    launchMajorityFills: 0,
    unmatchedOwnerCodes: {},
    unresolved: [],
    unresolvedTotal: 0,
    unresolvedSectorTotal: 0,
  };

  // ── Pass A: Owner → org (sector / country / org display name) ──────────────
  for (const rec of map.values()) {
    const needSector = rec.sectors.length === 0;
    const needCountry = !rec.operatorCountry;
    const needOrg = !rec.operatorOrg;
    if (!needSector && !needCountry && !needOrg) continue;
    const code = primaryOwnerCode(rec);
    if (!code) continue;
    const org = orgs.get(code);
    if (!org) {
      if (needSector) {
        report.unmatchedOwnerCodes[code] = (report.unmatchedOwnerCodes[code] ?? 0) + 1;
      }
      continue;
    }
    const prov: FacetProvenance = {};
    if (needSector && org.sectors.length > 0) {
      rec.sectors = [...org.sectors];
      prov.sectors = 'gcat-org';
      report.ownerSector++;
    }
    if (needCountry && org.stateCode) {
      rec.operatorCountry = canonicalFromSatcatState(org.stateCode);
      prov.country = 'gcat-org';
      report.ownerCountry++;
    }
    if (needOrg) {
      rec.operatorOrg = org.name;
      prov.org = 'gcat-org';
      report.ownerOrgName++;
    }
    stamp(rec, prov, 'gcat-org');
  }

  // Purpose is inheritable only when truly unstated: 'other' WITHOUT a gcat/ucs
  // provenance stamp ('other' sourced from psatcat SS/PLAN/… is a statement).
  const purposeOpen = (rec: ObjectMetadata): boolean =>
    rec.purpose === 'other' && rec.facetProvenance?.purpose === undefined;

  // ── Pass B: parent walk (purpose/program from the nearest ancestor payload) ─
  for (const rec of map.values()) {
    if (!purposeOpen(rec) && rec.program) continue;
    const ancestor = walkToPayload(rec, map, jcatToNorad);
    if (!ancestor) continue;
    if (adoptFrom(rec, ancestor, purposeOpen)) report.parentWalkFills++;
  }

  // ── Pass C: launch-payload majority ─────────────────────────────────────────
  const byTag = new Map<string, { purpose: Map<Purpose, number>; program: Map<string, number> }>();
  for (const rec of map.values()) {
    if (rec.objectType !== 'payload' || !rec.launchTag) continue;
    const bucket = byTag.get(rec.launchTag) ?? { purpose: new Map(), program: new Map() };
    if (rec.purpose !== 'other') {
      bucket.purpose.set(rec.purpose, (bucket.purpose.get(rec.purpose) ?? 0) + 1);
    }
    if (rec.program) {
      bucket.program.set(rec.program, (bucket.program.get(rec.program) ?? 0) + 1);
    }
    byTag.set(rec.launchTag, bucket);
  }
  for (const rec of map.values()) {
    const needPurpose = purposeOpen(rec);
    const needProgram = !rec.program;
    if ((!needPurpose && !needProgram) || !rec.launchTag) continue;
    const bucket = byTag.get(rec.launchTag);
    if (!bucket) continue;
    const prov: FacetProvenance = {};
    let filled = false;
    if (needPurpose) {
      const p = majority(bucket.purpose);
      if (p) {
        rec.purpose = p;
        prov.purpose = 'inherited';
        filled = true;
      }
    }
    if (needProgram) {
      const p = majority(bucket.program);
      if (p) {
        rec.program = p;
        prov.program = 'inherited';
        filled = true;
      }
    }
    if (filled) {
      stamp(rec, prov, 'inherited');
      report.launchMajorityFills++;
    }
  }

  // ── The explicit unknowns ────────────────────────────────────────────────────
  for (const rec of map.values()) {
    if (rec.orbitalStatus !== IN_ORBIT) continue;
    if (rec.sectors.length === 0) report.unresolvedSectorTotal++;
    if (purposeOpen(rec) && !rec.program) {
      report.unresolvedTotal++;
      if (report.unresolved.length < 50) {
        report.unresolved.push({
          norad: rec.noradId,
          jcat: rec.jcat,
          type: rec.objectType,
          reason: rec.parentJcat
            ? `parent ${rec.parentJcat} outside NORAD map; no classed payloads on launch ${rec.launchTag ?? '(none)'}`
            : `no parent; no classed payloads on launch ${rec.launchTag ?? '(none)'}`,
        });
      }
    }
  }

  return report;
}

/** Walk the separation tree to the nearest ancestor PAYLOAD (depth-capped). */
function walkToPayload(
  rec: ObjectMetadata,
  map: Map<number, ObjectMetadata>,
  jcatToNorad: Map<string, number>,
): ObjectMetadata | null {
  const seen = new Set<string>();
  let cur = rec.parentJcat;
  for (let depth = 0; cur && depth < 10; depth++) {
    if (seen.has(cur)) return null; // cycle guard
    seen.add(cur);
    const norad = jcatToNorad.get(cur);
    if (norad === undefined) return null; // A/R-jcat etc. — graceful miss
    const anc = map.get(norad);
    if (!anc) return null;
    if (anc.objectType === 'payload') return anc;
    cur = anc.parentJcat;
  }
  return null;
}

/** Copy purpose/program from the ancestor, only-empty; returns true if anything filled. */
function adoptFrom(
  rec: ObjectMetadata,
  ancestor: ObjectMetadata,
  purposeOpen: (r: ObjectMetadata) => boolean,
): boolean {
  const prov: FacetProvenance = {};
  let filled = false;
  if (purposeOpen(rec) && ancestor.purpose !== 'other') {
    rec.purpose = ancestor.purpose;
    prov.purpose = 'inherited';
    filled = true;
  }
  if (!rec.program && ancestor.program) {
    rec.program = ancestor.program;
    prov.program = 'inherited';
    filled = true;
  }
  if (!rec.gcatProgram && ancestor.gcatProgram) rec.gcatProgram = ancestor.gcatProgram;
  if (filled) stamp(rec, prov, 'inherited');
  return filled;
}

/** Highest count wins; ties broken lexicographically for determinism. */
function majority<K extends string>(counts: Map<K, number>): K | null {
  let best: K | null = null;
  let bestN = 0;
  for (const [k, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}
