// Tests for the G2 graph inheritance pass — owner join, parent walk,
// launch majority, provenance discipline, unresolved reporting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGraphInheritance } from '../../src/enrichment/gcat/inherit.js';
import type { OrgRecord } from '../../src/enrichment/gcat/orgs.js';
import { ObjectMetadata, emptyObjectMetadata } from '../../src/enrichment/types.js';

function org(code: string, over: Partial<OrgRecord> = {}): [string, OrgRecord] {
  return [code, {
    code, name: code + ' Org', stateCode: 'US', cls: 'B', sectors: ['commercial'],
    type: 'O', parent: null, lat: null, lon: null, tstart: null, tstop: null, ...over,
  }];
}

interface RecOver extends Partial<ObjectMetadata> { norad: number }

function rec(over: RecOver): [number, ObjectMetadata] {
  const r = emptyObjectMetadata(over.norad);
  Object.assign(r, over, { noradId: over.norad });
  return [over.norad, r];
}

function run(recs: [number, ObjectMetadata][], orgEntries: [string, OrgRecord][]) {
  const map = new Map(recs);
  const jcatToNorad = new Map<string, number>();
  for (const [, r] of recs) if (r.jcat) jcatToNorad.set(r.jcat, r.noradId);
  const report = applyGraphInheritance(map, jcatToNorad, new Map(orgEntries));
  return { map, report };
}

// ── Pass A: owner → org ───────────────────────────────────────────────────────

test('owner join fills sector/country/orgName with gcat-org provenance', () => {
  const { map, report } = run(
    [rec({ norad: 1, orbitalStatus: 'in_orbit', objectType: 'debris',
           gcat: { owner: 'RVSN' } })],
    [org('RVSN', { cls: 'D', sectors: ['military'], stateCode: 'SU', name: 'RVSN' })],
  );
  const r = map.get(1)!;
  assert.deepEqual(r.sectors, ['military']);
  assert.equal(r.operatorCountry, 'CIS');            // SU canonicalized
  assert.equal(r.operatorOrg, 'RVSN');
  assert.equal(r.facetProvenance?.sectors, 'gcat-org');
  assert.equal(r.facetProvenance?.country, 'gcat-org');
  assert.equal(r.facetProvenance?.org, 'gcat-org');
  assert.deepEqual(r.sources, ['gcat-org']);
  assert.equal(report.ownerSector, 1);
});

test('owner join never overwrites stated facets; multi-code + ? handled', () => {
  const { map } = run(
    [rec({ norad: 1, sectors: ['civil'], operatorCountry: 'US', operatorOrg: 'NASA',
           facetProvenance: { sectors: 'gcat' }, gcat: { owner: 'RVSN?/MO' } })],
    [org('RVSN', { cls: 'D', sectors: ['military'], stateCode: 'SU' })],
  );
  const r = map.get(1)!;
  assert.deepEqual(r.sectors, ['civil']);
  assert.equal(r.operatorCountry, 'US');
  assert.equal(r.operatorOrg, 'NASA');
  assert.equal(r.facetProvenance?.sectors, 'gcat');
});

test('unmatched owner codes surface in the report', () => {
  const { report } = run(
    [rec({ norad: 1, gcat: { owner: 'WAT' } })],
    [],
  );
  assert.deepEqual(report.unmatchedOwnerCodes, { WAT: 1 });
});

// ── Pass B: parent walk ───────────────────────────────────────────────────────

test('parent walk: multi-hop to nearest ancestor payload, inherited provenance', () => {
  const { map, report } = run(
    [
      rec({ norad: 10, jcat: 'S00010', objectType: 'payload',
            purpose: 'meteorological', program: 'fengyun', gcatProgram: 'FY-1' }),
      rec({ norad: 11, jcat: 'S00011', objectType: 'component', parentJcat: 'S00010' }),
      rec({ norad: 12, jcat: 'S00012', objectType: 'debris', parentJcat: 'S00011' }),
    ],
    [],
  );
  const deb = map.get(12)!;
  assert.equal(deb.purpose, 'meteorological');       // walked THROUGH the component
  assert.equal(deb.program, 'fengyun');
  assert.equal(deb.gcatProgram, 'FY-1');
  assert.equal(deb.facetProvenance?.purpose, 'inherited');
  assert.equal(deb.facetProvenance?.program, 'inherited');
  assert.ok(deb.sources.includes('inherited'));
  assert.equal(report.parentWalkFills, 2);           // component + debris
});

test('parent walk: gcat-stated "other" purpose is NOT overwritten', () => {
  const { map } = run(
    [
      rec({ norad: 10, jcat: 'S00010', objectType: 'payload', purpose: 'communications' }),
      rec({ norad: 11, jcat: 'S00011', objectType: 'component', parentJcat: 'S00010',
            purpose: 'other', facetProvenance: { purpose: 'gcat' } }),
    ],
    [],
  );
  assert.equal(map.get(11)!.purpose, 'other');       // SS-style statement kept
});

test('parent walk: A-jcat parent misses gracefully; cycles guarded', () => {
  const { map, report } = run(
    [
      rec({ norad: 20, jcat: 'S00020', objectType: 'debris', parentJcat: 'A11915',
            orbitalStatus: 'in_orbit' }),
      rec({ norad: 21, jcat: 'S00021', objectType: 'debris', parentJcat: 'S00022' }),
      rec({ norad: 22, jcat: 'S00022', objectType: 'debris', parentJcat: 'S00021' }),
    ],
    [],
  );
  assert.equal(map.get(20)!.purpose, 'other');
  assert.equal(report.parentWalkFills, 0);
  assert.equal(map.get(21)!.program, undefined);     // cycle didn't hang or fill
});

// ── Pass C: launch majority ───────────────────────────────────────────────────

test('launch majority: majority wins; deterministic tie-break; provenance', () => {
  const { map, report } = run(
    [
      rec({ norad: 30, objectType: 'payload', launchTag: '2020-001',
            purpose: 'communications', program: 'starlink' }),
      rec({ norad: 31, objectType: 'payload', launchTag: '2020-001',
            purpose: 'communications', program: 'starlink' }),
      rec({ norad: 32, objectType: 'payload', launchTag: '2020-001',
            purpose: 'earth_observation', program: 'skysat' }),
      rec({ norad: 33, objectType: 'rocket_body', launchTag: '2020-001',
            orbitalStatus: 'in_orbit' }),
    ],
    [],
  );
  const rb = map.get(33)!;
  assert.equal(rb.purpose, 'communications');
  assert.equal(rb.program, 'starlink');
  assert.equal(rb.facetProvenance?.purpose, 'inherited');
  assert.equal(rb.facetProvenance?.program, 'inherited');
  assert.equal(report.launchMajorityFills, 1);
});

test('parent walk takes precedence over launch majority', () => {
  const { map } = run(
    [
      rec({ norad: 40, jcat: 'S00040', objectType: 'payload', launchTag: '2020-002',
            purpose: 'navigation', program: 'gps' }),
      rec({ norad: 41, jcat: 'S00041', objectType: 'payload', launchTag: '2020-002',
            purpose: 'communications', program: 'starlink' }),
      rec({ norad: 42, jcat: 'S00042', objectType: 'debris', launchTag: '2020-002',
            parentJcat: 'S00040', orbitalStatus: 'in_orbit' }),
    ],
    [],
  );
  assert.equal(map.get(42)!.purpose, 'navigation');  // from ITS parent, not majority
  assert.equal(map.get(42)!.program, 'gps');
});

// ── Unresolved reporting ──────────────────────────────────────────────────────

test('objects surviving all passes land in the unresolved list (in-orbit only)', () => {
  const { report } = run(
    [
      rec({ norad: 50, jcat: 'S00050', objectType: 'debris', orbitalStatus: 'in_orbit',
            parentJcat: 'A99999', launchTag: '1999-999' }),
      rec({ norad: 51, jcat: 'S00051', objectType: 'debris', orbitalStatus: 'decayed' }),
    ],
    [],
  );
  assert.equal(report.unresolvedTotal, 1);           // decayed one not counted
  assert.equal(report.unresolved[0].norad, 50);
  assert.match(report.unresolved[0].reason, /A99999/);
  assert.equal(report.unresolvedSectorTotal, 1);     // no owner either
});
