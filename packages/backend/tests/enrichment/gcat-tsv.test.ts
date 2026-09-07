import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGcatTsv } from '../../src/enrichment/gcat/tsv.js';

const FIXTURE = [
  '#Code\tUCode\tStateCode\tType\tClass\tName',
  '# Updated 2026 Jul  3 2202:24',
  'SPXS\tSPX\tUS\tO/LV\tB\tSpaceX',
  'NASA\tNASA\tUS\tO/LA\tC\tNational Aeronautics and Space Administration',
  '# Solid propellant engines',
  'MISSING\tX\t-\tO\tB\t-',
].join('\n');

test('strips leading # from the header and parses tab cells', () => {
  const t = parseGcatTsv(FIXTURE);
  assert.deepEqual(t.columns, ['Code', 'UCode', 'StateCode', 'Type', 'Class', 'Name']);
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[0].Code, 'SPXS');
  assert.equal(t.rows[0].Class, 'B');
  assert.equal(t.rows[1].Name, 'National Aeronautics and Space Administration');
});

test('extracts the snapshot date; skips mid-file comment lines', () => {
  const t = parseGcatTsv(FIXTURE);
  assert.equal(t.snapshotDate, '2026 Jul  3 2202:24');
  assert.equal(t.rows.some((r) => r.Code?.includes('Solid')), false);
});

test("GCAT '-' missing marker becomes empty string; short rows pad empty", () => {
  const t = parseGcatTsv(FIXTURE);
  assert.equal(t.rows[2].StateCode, '');
  assert.equal(t.rows[2].Name, '');
});

test('throws when no header line exists', () => {
  assert.throws(() => parseGcatTsv('a\tb\nc\td'), /no #-prefixed header/);
});
