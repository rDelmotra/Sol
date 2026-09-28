// ============================================================
// P3 S1 — EnrichmentProvider: static-plane + dotted-join fields over the
// boot-loaded GCAT/UCS enrichment store (69k records).
// Spec: my_plans/marvin/p3/S1_enrichment_provider.md
//
// Serves every static-plane field in FIELD_REGISTRY plus the six real dotted
// joins the client vocab cannot carry, and `descendsFrom` via a boot-built
// jcat separation tree. All lookups are in-memory Map hits — no per-request I/O.
// ============================================================

import type { FieldValue } from '@orbitwatch/analytic';
import { PROGRAM_LABELS } from '@orbitwatch/contracts';
import {
  loadEnrichment,
  loadOrgs,
  getLaunch,
  deriveInlineFacets,
} from '../../enrichment/store.js';
import { primaryOwnerCode } from '../../enrichment/store.js';
import { logger } from '../../utils/logger.js';
import { parseGcatDate } from './gcat-date.js';
import type { FieldProvider } from '../types.js';

// ── Claimed fields ────────────────────────────────────────────────────────────
// Exactly the field keys from the S1 spec table. Catalog-plane fields
// (countryCode, launchDate, launchYear) are claimed as chain fallbacks for the
// 'all' universe where no TLE/catalog provider covers decayed objects.
const ENRICHMENT_FIELDS: readonly string[] = [
  // Identity
  'cospar', 'jcat', 'objectType', 'status', 'operationalStatus',
  // Facets
  'sectors', 'purpose', 'program', 'program.label',
  // Ownership
  'countryCode', 'owner', 'owner.name', 'owner.stateCode', 'owner.cls', 'ownerFamily',
  // Launch / tree
  'launchTag', 'parentJcat', 'launchDate', 'launchYear',
  // Physical (static-plane from GCAT/UCS)
  'launchMassKg', 'dryMassKg', 'totMassKg',
  'lengthM', 'diameterM', 'spanM',
  'powerW', 'expectedLifetimeYrs', 'bus', 'shape',
  // Dotted joins (launch record + org record)
  'launch.date', 'launch.lvType', 'launch.lvFamily', 'launch.siteName',
  'launch.pad', 'launch.success',
];

// ── Separation-tree indexes (lazy singletons) ─────────────────────────────────
let jcatToNorad: Map<string, number> | null = null;
let noradToParentJcat: Map<number, string> | null = null;

function ensureTree(): void {
  if (jcatToNorad) return;
  const map = loadEnrichment();
  const j2n = new Map<string, number>();
  const n2p = new Map<number, string>();
  for (const [norad, rec] of map) {
    if (rec.jcat) j2n.set(rec.jcat, norad);
    if (rec.parentJcat) n2p.set(norad, rec.parentJcat);
  }
  jcatToNorad = j2n;
  noradToParentJcat = n2p;
  logger.info(`descendsFrom tree built: ${j2n.size} jcat nodes, ${n2p.size} parent edges`);
}

// ── Org parent-walk (mirrors live-source ownerFamilyRoot) ─────────────────────
function ownerFamilyRoot(code: string): string {
  const orgs = loadOrgs();
  let cur = code;
  for (let hop = 0; hop < 10; hop++) {
    const org = orgs.get(cur);
    if (!org) return cur; // unknown org code — return what we have
    const parent = org.parent;
    if (!parent || !orgs.has(parent)) return cur;
    cur = parent;
  }
  return cur; // depth limit reached
}

// ── Provider factory ──────────────────────────────────────────────────────────

export function createEnrichmentProvider(): FieldProvider {
  const enrichment = loadEnrichment();

  function getField(noradId: number, field: string, _tMs: number): FieldValue {
    const m = enrichment.get(noradId);
    if (!m) return null;

    switch (field) {
      // ── Identity ─────────────────────────────────────────────────────────
      case 'cospar': return m.cospar;
      case 'jcat': return m.jcat ?? null;
      case 'objectType': return m.objectType;
      case 'status': return m.orbitalStatus;
      // 'unknown' → null: serving ignorance as a value would make != 'operational'
      // match things we simply don't know — skip-and-count is the honest path.
      case 'operationalStatus':
        return m.operationalStatus === 'unknown' ? null : m.operationalStatus;

      // ── Facets (computed via deriveInlineFacets — NOT raw reads, so the
      //    program-registry precedence rules hold identically server-side) ──
      case 'sectors': {
        const f = deriveInlineFacets(m);
        return f.sectors; // [] served verbatim (has [] → false, correct)
      }
      case 'purpose': {
        const f = deriveInlineFacets(m);
        return f.purpose; // 'other' served verbatim (= explicit "unspecified")
      }
      case 'program': {
        const f = deriveInlineFacets(m);
        return f.program ?? null;
      }
      case 'program.label': {
        const slug = deriveInlineFacets(m).program;
        if (!slug) return null;
        return (PROGRAM_LABELS as Record<string, string>)[slug] ?? slug;
      }

      // ── Ownership ────────────────────────────────────────────────────────
      case 'countryCode': {
        const f = deriveInlineFacets(m);
        return f.operatorCountry;
      }
      case 'owner': {
        const f = deriveInlineFacets(m);
        return f.owner ?? null;
      }
      case 'owner.name': {
        const code = primaryOwnerCode(m);
        if (!code) return null;
        return loadOrgs().get(code)?.name ?? null;
      }
      case 'owner.stateCode': {
        const code = primaryOwnerCode(m);
        if (!code) return null;
        return loadOrgs().get(code)?.stateCode ?? null;
      }
      case 'owner.cls': {
        const code = primaryOwnerCode(m);
        if (!code) return null;
        return loadOrgs().get(code)?.cls ?? null;
      }
      case 'ownerFamily': {
        const f = deriveInlineFacets(m);
        const code = f.owner;
        if (!code) return null;
        return ownerFamilyRoot(code);
      }

      // ── Launch / tree ────────────────────────────────────────────────────
      case 'launchTag': return m.launchTag ?? null;
      case 'parentJcat': return m.parentJcat ?? null;
      case 'launchDate': return parseGcatDate(m.launchDate);
      case 'launchYear': {
        if (!m.launchDate) return null;
        const match = m.launchDate.match(/\d{4}/);
        return match ? parseInt(match[0], 10) : null;
      }

      // ── Physical ─────────────────────────────────────────────────────────
      // All optional/nullable fields use ?? null — the type says `null` but the
      // JSON may omit the key entirely, yielding `undefined` at runtime.
      case 'launchMassKg': return m.launchMassKg ?? null;
      case 'dryMassKg': return m.dryMassKg ?? null;
      case 'totMassKg': return m.totMassKg ?? null;
      case 'lengthM': return m.lengthM ?? null;
      case 'diameterM': return m.diameterM ?? null;
      case 'spanM': return m.spanM ?? null;
      case 'powerW': return m.powerW ?? null;
      case 'expectedLifetimeYrs': return m.expectedLifetimeYrs ?? null;
      case 'bus': return m.bus ?? null;
      case 'shape': return m.shape ?? null;

      // ── Launch record join ────────────────────────────────────────────────
      case 'launch.date': {
        const l = m.launchTag ? getLaunch(m.launchTag) : undefined;
        return l ? parseGcatDate(l.date) : null;
      }
      case 'launch.lvType': {
        const l = m.launchTag ? getLaunch(m.launchTag) : undefined;
        return l?.lvType ?? null;
      }
      case 'launch.lvFamily': {
        const l = m.launchTag ? getLaunch(m.launchTag) : undefined;
        return l?.lvFamily ?? null;
      }
      case 'launch.siteName': {
        const l = m.launchTag ? getLaunch(m.launchTag) : undefined;
        return l?.siteName ?? null;
      }
      case 'launch.pad': {
        const l = m.launchTag ? getLaunch(m.launchTag) : undefined;
        return l?.pad ?? null;
      }
      case 'launch.success': {
        const l = m.launchTag ? getLaunch(m.launchTag) : undefined;
        return l?.success ?? null;
      }

      default: return null;
    }
  }

  function descendsFrom(noradId: number, ancestorNoradId: number): boolean {
    ensureTree();
    // Self is NOT its own descendant (strict).
    if (noradId === ancestorNoradId) return false;
    const ancestorJcat = enrichment.get(ancestorNoradId)?.jcat;
    if (!ancestorJcat) return false;

    let cur = noradToParentJcat!.get(noradId);
    for (let hop = 0; cur !== undefined && hop < 32; hop++) {
      if (cur === ancestorJcat) return true;
      // Walk one hop up: jcat → norad → parentJcat
      const parentNorad = jcatToNorad!.get(cur);
      if (parentNorad === undefined) return false; // org/EARTH-style parent or missing record
      cur = noradToParentJcat!.get(parentNorad);
    }
    return false;
  }

  return {
    id: 'enrichment',
    fields: ENRICHMENT_FIELDS,
    fns: ['descendsFrom'],
    getField,
    descendsFrom,
  };
}
