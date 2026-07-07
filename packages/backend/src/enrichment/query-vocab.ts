// ============================================================
// query-vocab.ts — compact search-vocabulary artifact builder (G3)
//
// Emits the client-side query tier's data-driven vocabulary:
//   launches: tag → [lvFamily, siteName]   (vehicle/site/year queries compile
//             down to launch-tag sets against this map)
//   orgs:     code → { n: name, a?: aliases }  — RESTRICTED to codes that own
//             at least one in-orbit object, so the runtime alias table stays
//             lean (~1k orgs, not all 2k referenced ones)
//
// ALL referenced launches ship (not just in-orbit ones): historical/decayed
// catalogs reference since-decayed objects and the size is trivial (~330 KB).
// Pure — unit-tests without snapshot files. Named to avoid gcat/vocab.ts.
// ============================================================

import type { ObjectMetadata } from './types.js';
import type { OrgRecord } from './gcat/orgs.js';
import type { LaunchRecord } from './gcat/launches.js';
import { primaryOwnerCode } from './gcat/inherit.js';

export interface QueryVocabArtifact {
  /** tag → [lvFamily, siteName] (nulls preserved — tuple positions are meaningful). */
  launches: Record<string, [string | null, string | null]>;
  /** In-orbit owner org codes only. `a` = remaining name variants, when any. */
  orgs: Record<string, { n: string; a?: string[] }>;
}

export function buildQueryVocab(
  records: Iterable<ObjectMetadata>,
  orgs: Map<string, OrgRecord>,
  referencedLaunches: Record<string, LaunchRecord>,
): QueryVocabArtifact {
  const launches: QueryVocabArtifact['launches'] = {};
  for (const [tag, l] of Object.entries(referencedLaunches)) {
    launches[tag] = [l.lvFamily, l.siteName];
  }

  const inOrbitOwners = new Set<string>();
  for (const rec of records) {
    if (rec.orbitalStatus !== 'in_orbit') continue;
    const code = primaryOwnerCode(rec);
    if (code && orgs.has(code)) inOrbitOwners.add(code);
  }
  const vocabOrgs: QueryVocabArtifact['orgs'] = {};
  for (const code of [...inOrbitOwners].sort()) {
    const o = orgs.get(code)!;
    vocabOrgs[code] = {
      n: o.name,
      ...(o.aliases && o.aliases.length > 0 ? { a: o.aliases } : {}),
    };
  }
  return { launches, orgs: vocabOrgs };
}
