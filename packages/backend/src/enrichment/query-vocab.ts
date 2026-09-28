// ============================================================
// query-vocab.ts — compact search-vocabulary artifact builder (G3)
//
// Emits the client-side query tier's data-driven vocabulary:
//   launches: tag → [lvFamily, siteName, agencyCodes]  (vehicle/site/year/agency
//             queries compile down to launch-tag sets against this map)
//   orgs:     code → { n: name, a?: aliases, p?: parent }  — the operator/agency
//             name vocabulary. Emitted set = in-orbit OWNERS ∪ their parent-tree
//             ANCESTORS ∪ launch AGENCIES ∪ agency ancestors, so the frontend can
//             (a) resolve an operator name to its whole org FAMILY (parent tree),
//             (b) resolve an agency name, and (c) still search a parent brand
//             (e.g. "amazon" → Kuiper) even when the brand owns nothing directly.
//
// ALL referenced launches ship (not just in-orbit ones): historical/decayed
// catalogs reference since-decayed objects and the size is trivial (~350 KB).
// Pure — unit-tests without snapshot files. Named to avoid gcat/vocab.ts.
// ============================================================

import type { LaunchRecord, ObjectMetadata, OrgRecord, QueryVocab } from '@orbitwatch/contracts';
import { primaryOwnerCode } from './gcat/inherit.js';

// The artifact shape (formerly this module's own `QueryVocabArtifact`) moved
// to @orbitwatch/contracts as `QueryVocab` (C3), merged with frontend
// data/query-vocab-client.ts's identical copy — zero field diffs.

/** Walk the parent chain of `code`, adding each ancestor to `out` (cycle/depth-safe). */
function collectAncestors(code: string, orgs: Map<string, OrgRecord>, out: Set<string>): void {
  let cur = orgs.get(code)?.parent ?? null;
  for (let i = 0; cur && i < 10; i++) {
    if (out.has(cur)) break; // already walked (also breaks cycles)
    out.add(cur);
    cur = orgs.get(cur)?.parent ?? null;
  }
}

export function buildQueryVocab(
  records: Iterable<ObjectMetadata>,
  orgs: Map<string, OrgRecord>,
  referencedLaunches: Record<string, LaunchRecord>,
): QueryVocab {
  const launches: QueryVocab['launches'] = {};
  for (const [tag, l] of Object.entries(referencedLaunches)) {
    launches[tag] = [l.lvFamily, l.siteName, l.agencies];
  }

  // In-orbit owners (the codes that actually own objects) — the client uses this
  // to tell operator names from agency-only names.
  const owners = new Set<string>();
  for (const rec of records) {
    if (rec.orbitalStatus !== 'in_orbit') continue;
    const code = primaryOwnerCode(rec);
    if (code && orgs.has(code)) owners.add(code);
  }

  // The emit set: owners + launch agencies, each closed over its ancestor chain
  // so family expansion + parent-brand search work on the client.
  const emit = new Set<string>(owners);
  for (const l of Object.values(referencedLaunches)) {
    for (const a of l.agencies) if (orgs.has(a)) emit.add(a);
  }
  for (const code of [...emit]) collectAncestors(code, orgs, emit);

  const vocabOrgs: QueryVocab['orgs'] = {};
  for (const code of [...emit].sort()) {
    const o = orgs.get(code);
    if (!o) continue;
    vocabOrgs[code] = {
      n: o.name,
      ...(o.aliases && o.aliases.length > 0 ? { a: o.aliases } : {}),
      ...(o.parent ? { p: o.parent } : {}),
    };
  }
  return { launches, orgs: vocabOrgs, owners: [...owners].sort() } satisfies QueryVocab;
}
