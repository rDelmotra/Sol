// Tests for the GCAT ingest pass — synthetic satcat/psatcat fixtures built
// programmatically (fixed widths derived from the same column list), covering
// field mapping, raw-block preservation, provenance stamps, NORAD dedupe,
// decayed-row emission, ERR exclusion, and the mapping report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGcat } from '../../tools/enrichment/gcat/ingest.js';
import type { DecayedCatalogRow, ObjectMetadata } from '@orbitwatch/contracts';

// ── Fixture builder ───────────────────────────────────────────────────────────

function buildCatalog(columns: [string, number][], rows: string[][]): string {
  const pad = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(columns[i][1])).join('').trimEnd();
  return [
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />',
    '<PRE>',
    pad(columns.map(([n]) => n)),
    '</PRE>',
    '# Updated 2026 Jul  3 2203:53',
    '<PRE>',
    ...rows.map(pad),
    '</PRE>',
  ].join('\n');
}

const SATCAT_COLS: [string, number][] = [
  ['JCAT', 13], ['Satcat', 12], ['Launch_Tag', 11], ['Piece', 15], ['Type', 13],
  ['Name', 29], ['LDate', 13], ['Parent', 15], ['Status', 7], ['Owner', 13], ['State', 13],
  ['Manufacturer', 19], ['Bus', 17], ['Motor', 13], ['Mass', 14], ['DryMass', 13],
  ['TotMass', 14], ['Length', 10], ['Diamete', 9], ['Span', 11], ['Shape', 33],
  ['OpOrbitOQU', 11],
];

const PSATCAT_COLS: [string, number][] = [
  ['JCAT', 13], ['Piece', 13], ['Name', 29], ['TLast', 13], ['TOp', 13],
  ['TDate', 21], ['TF', 3], ['Program', 17], ['Plane', 9], ['At', 3], ['Mv', 3],
  ['Clas', 5], ['Category', 19],
];

function satRow(over: Partial<Record<string, string>>): string[] {
  const d: Record<string, string> = {
    JCAT: 'S00001', Satcat: '00001', Launch_Tag: '2020-001', Piece: '2020-001A',
    Type: 'P', Name: 'Testsat 1', LDate: '2020 Jan  1', Parent: '-', Status: 'O', Owner: 'SPXS',
    State: 'US', Manufacturer: 'SPX', Bus: 'Starlink', Motor: '-', Mass: '260',
    DryMass: '250', TotMass: '260', Length: '3.0', Diamete: '1.5', Span: '8.0',
    Shape: 'Box + pan', OpOrbitOQU: 'LLEO/I -', ...over,
  };
  return SATCAT_COLS.map(([n]) => d[n] ?? '-');
}

function psatRow(over: Partial<Record<string, string>>): string[] {
  const d: Record<string, string> = {
    JCAT: 'S00001', Piece: '2020-001A', Name: 'Testsat 1', TLast: '2026 Jun  1',
    TOp: '*', TDate: '*', TF: '-', Program: 'Starlink 2M S1', Plane: '-', At: 'P',
    Mv: 'M', Clas: 'B', Category: 'COM', ...over,
  };
  return PSATCAT_COLS.map(([n]) => d[n] ?? '-');
}

function run(satRows: string[][], psatRows: string[][]) {
  const map = new Map<number, ObjectMetadata>();
  const decayed: DecayedCatalogRow[] = [];
  const names = new Map<number, string>();
  const result = ingestGcat(
    buildCatalog(SATCAT_COLS, satRows),
    buildCatalog(PSATCAT_COLS, psatRows),
    map, decayed, names,
  );
  return { map, decayed, names, result };
}

// ── satcat field mapping ──────────────────────────────────────────────────────

test('satcat row → record: fields, raw block, provenance, sources', () => {
  const { map, names, result } = run([satRow({})], [psatRow({})]);
  const rec = map.get(1)!;
  assert.equal(rec.jcat, 'S00001');
  assert.equal(rec.launchTag, '2020-001');
  assert.equal(rec.cospar, '2020-001A');
  assert.equal(rec.launchDate, '2020 Jan  1');
  assert.equal(rec.orbitalStatus, 'in_orbit');
  assert.equal(rec.objectType, 'payload');
  assert.equal(rec.operatorCountry, 'US');
  assert.equal(rec.orbitClass, 'LLEO/I');
  assert.equal(rec.launchMassKg, 260);
  assert.equal(rec.dryMassKg, 250);
  assert.equal(rec.totMassKg, 260);
  assert.equal(rec.lengthM, 3.0);
  assert.equal(rec.diameterM, 1.5);
  assert.equal(rec.spanM, 8.0);
  assert.equal(rec.bus, 'Starlink');
  assert.equal(rec.shape, 'Box + pan');
  // operatorOrg stays null — Owner code is raw-block only until G2
  assert.equal(rec.operatorOrg, null);
  assert.equal(rec.gcat?.owner, 'SPXS');
  assert.equal(rec.gcat?.state, 'US');
  assert.equal(rec.gcat?.manufacturer, 'SPX');
  assert.equal(rec.gcat?.status, 'O');
  assert.equal(rec.gcat?.opOrbit, 'LLEO/I -');
  assert.equal(rec.facetProvenance?.country, 'gcat');
  assert.deepEqual(rec.sources, ['gcat']);
  assert.equal(names.get(1), 'Testsat 1');
  assert.equal(result.snapshotDate, '2026 Jul  3 2203:53');
});

test('psatcat overlay: sectors/purpose/program/dates/maneuverability', () => {
  const { map } = run([satRow({})], [psatRow({})]);
  const rec = map.get(1)!;
  assert.deepEqual(rec.sectors, ['commercial']);
  assert.equal(rec.purpose, 'communications');
  assert.equal(rec.facetProvenance?.sectors, 'gcat');
  assert.equal(rec.facetProvenance?.purpose, 'gcat');
  assert.equal(rec.gcatProgram, 'Starlink 2M S1');
  assert.equal(rec.gcat?.program, 'Starlink 2M S1');
  assert.equal(rec.gcat?.clas, 'B');
  assert.equal(rec.gcat?.category, 'COM');
  assert.equal(rec.maneuverability, 'M');
  assert.equal(rec.attitudeControl, 'P');
  assert.equal(rec.detailedPurpose, 'COM');
  // TOp='*' → believed still operating
  assert.equal(rec.operationalStatus, 'operational');
  assert.equal(rec.endOpDate, undefined);
  assert.equal(rec.lastActiveDate, '2026 Jun  1');
});

test('operational status: real TOp date → nonoperational; TF=Z zombie', () => {
  const { map } = run(
    [satRow({}), satRow({ JCAT: 'S00002', Satcat: '00002', Piece: '2020-001B' })],
    [
      psatRow({ TOp: '2021 Mar  5', TDate: '2022 Jan  1' }),
      psatRow({ JCAT: 'S00002', TOp: '*', TF: 'Z' }),
    ],
  );
  const dead = map.get(1)!;
  assert.equal(dead.operationalStatus, 'nonoperational');
  assert.equal(dead.endOpDate, '2021 Mar  5');
  assert.equal(dead.endTransmitDate, '2022 Jan  1');
  // TOp='*' wins over TF=Z? No — '*' means believed operating; but a zombie
  // flag contradicts full operation. Current rule: TOp='*' → operational first.
  assert.equal(map.get(2)!.operationalStatus, 'operational');
});

// ── Status mapping edge cases ─────────────────────────────────────────────────

test('decayed rows emitted for decayed/deorbited/exploded; ERR excluded', () => {
  const { map, decayed, result } = run(
    [
      satRow({ JCAT: 'S00010', Satcat: '00010', Status: 'R' }),    // decayed
      satRow({ JCAT: 'S00011', Satcat: '00011', Status: 'L' }),    // landed → deorbited
      satRow({ JCAT: 'S00012', Satcat: '00012', Status: 'E' }),    // exploded
      satRow({ JCAT: 'S00013', Satcat: '00013', Status: 'ERR' }),  // error → unknown
      satRow({ JCAT: 'S00014', Satcat: '00014', Status: 'O' }),    // in orbit
      satRow({ JCAT: 'S00015', Satcat: '00015', Status: 'WAT' }),  // unmapped
    ],
    [],
  );
  assert.deepEqual(
    decayed.map((d) => [d.noradId, d.status]),
    [[10, 'decayed'], [11, 'deorbited'], [12, 'exploded']],
  );
  assert.equal(decayed[0].launchYear, 2020);
  assert.equal(map.get(11)!.gcat?.status, 'L');     // raw preserved for the fold
  assert.equal(map.get(13)!.orbitalStatus, 'unknown');
  assert.equal(map.get(15)!.orbitalStatus, 'unknown');
  assert.deepEqual(result.report.unmappedStatus, { WAT: 1 });
});

test('parentJcat: first token, * and port suffix stripped, raw preserved', () => {
  const { map, result } = run(
    [
      satRow({}),
      satRow({ JCAT: 'S00002', Satcat: '00002', Parent: 'S00001* PMA-1' }),
      satRow({ JCAT: 'S00003', Satcat: '00003', Parent: 'A11915' }),
    ],
    [],
  );
  assert.equal(map.get(1)!.parentJcat, undefined);
  assert.equal(map.get(1)!.gcat?.parent, undefined);
  const r2 = map.get(2)!;
  assert.equal(r2.parentJcat, 'S00001');
  assert.equal(r2.gcat?.parent, 'S00001* PMA-1');       // verbatim
  assert.equal(map.get(3)!.parentJcat, 'A11915');       // non-S kept (walk misses gracefully)
  assert.equal(result.jcatToNorad.get('S00002'), 2);
});

test('uncertain codes: R? maps to decayed; state ?-suffix joins the table', () => {
  const { map } = run(
    [satRow({ Status: 'R?', State: 'SU?' })],
    [],
  );
  const rec = map.get(1)!;
  assert.equal(rec.orbitalStatus, 'decayed');
  assert.equal(rec.gcat?.status, 'R?');           // verbatim
  assert.equal(rec.operatorCountry, 'CIS');       // SU? → SU → CIS
  assert.equal(rec.gcat?.state, 'SU?');
});

// ── NORAD dedupe ──────────────────────────────────────────────────────────────

test('NORAD collision: non-N row beats renamed N row; collision logged', () => {
  const { map, result } = run(
    [
      satRow({ JCAT: 'S00050', Satcat: '00050', Name: 'Old Name', Status: 'N' }),
      satRow({ JCAT: 'S00051', Satcat: '00050', Name: 'New Name', Status: 'O' }),
    ],
    [],
  );
  const rec = map.get(50)!;
  assert.equal(rec.jcat, 'S00051');
  assert.equal(rec.orbitalStatus, 'in_orbit');
  assert.deepEqual(result.report.noradCollisions, [
    { norad: 50, kept: 'S00051', dropped: 'S00050' },
  ]);
});

test('NORAD collision: both non-N → later JCAT wins', () => {
  const { map } = run(
    [
      satRow({ JCAT: 'S00060', Satcat: '00060', Name: 'A', Status: 'O' }),
      satRow({ JCAT: 'S00061', Satcat: '00060', Name: 'B', Status: 'O' }),
    ],
    [],
  );
  assert.equal(map.get(60)!.jcat, 'S00061');
});

test('rows without numeric NORAD are skipped and counted', () => {
  const { map, result } = run(
    [satRow({ Satcat: 'NNA' }), satRow({ JCAT: 'S00002', Satcat: '00002' })],
    [],
  );
  assert.equal(map.size, 1);
  assert.equal(result.report.skippedNoNorad, 1);
});

test('psatcat rows without a joined satcat row are counted, not applied', () => {
  const { result } = run([satRow({})], [psatRow({ JCAT: 'S99999' })]);
  assert.equal(result.report.psatcatUnjoined, 1);
});

// ── Report: unknown clas chars, category tokens, passthrough states ───────────

test('unknown Clas char and Category token surface in the report', () => {
  const { map, result } = run(
    [satRow({ State: 'UY' })],
    [psatRow({ Clas: 'BX', Category: 'XYZZY/COM' })],
  );
  const rec = map.get(1)!;
  assert.deepEqual(rec.sectors, ['commercial']);          // B still applies
  assert.equal(rec.purpose, 'other');                     // unmapped primary
  assert.equal(rec.facetProvenance?.purpose, undefined);  // not stamped
  assert.equal(rec.detailedPurpose, 'XYZZY/COM');         // raw kept anyway
  assert.deepEqual(result.report.unmappedClas, { X: 1 });
  assert.deepEqual(result.report.unmappedCategory, { XYZZY: 1 });
  assert.deepEqual(result.report.passthroughStateCodes, { UY: 1 });
  assert.equal(rec.operatorCountry, 'UY');                // pass-through raw
});

test('missing cells produce no raw-block keys and no empty objects', () => {
  const { map } = run(
    [satRow({ Owner: '-', State: '-', Manufacturer: '-', Bus: '-', Shape: '-',
              Mass: '0', DryMass: '0', TotMass: '0', Length: '0.0',
              Diamete: '0.0', Span: '0.0', OpOrbitOQU: '-' })],
    [],
  );
  const rec = map.get(1)!;
  assert.equal(rec.launchMassKg, null);   // 0 = unknown for GCAT masses
  assert.equal(rec.lengthM, undefined);
  assert.equal(rec.bus, undefined);
  assert.equal(rec.orbitClass, null);
  assert.equal(rec.gcat?.owner, undefined);
  assert.equal(rec.gcat?.state, undefined);
  // status + type still present (they were 'O' / 'P')
  assert.equal(rec.gcat?.status, 'O');
  assert.equal(rec.facetProvenance?.country, undefined);
});
