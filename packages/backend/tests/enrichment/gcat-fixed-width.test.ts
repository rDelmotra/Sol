// Tests for the GCAT fixed-width parser — synthetic fixture mirroring the
// exact 7-line HTML-wrapped structure of the real cats/ downloads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGcatCatalog,
  cleanCode,
  cleanNum,
  yearOf,
} from '../../src/enrichment/gcat/fixed-width.js';

// Columns deliberately non-uniform widths; offsets must come from the header.
const FIXTURE = [
  '<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />',
  '<PRE>',
  'JCAT         Satcat      Name                Status Owner        State',
  '</PRE>',
  '# Updated 2026 Jul  3 2203:53',
  '<PRE>',
  'S00005       00005       Vanguard 1          O      NRL          US',
  'S12345       12345       Test Bird?          R?     GSFC?        SU',
  'S99999       NNA         No Norad            O      -            -',
  'SHORTLINE',
  'notajcat     11111       Bad Row             O      X            Y',
  '</PRE>',
].join('\n');

test('derives offsets from header and extracts trimmed cells', () => {
  const cat = parseGcatCatalog(FIXTURE);
  assert.deepEqual(cat.columns, ['JCAT', 'Satcat', 'Name', 'Status', 'Owner', 'State']);
  assert.equal(cat.rows.length, 3);
  const r = cat.rows[0];
  assert.equal(r.JCAT, 'S00005');
  assert.equal(r.Satcat, '00005');
  assert.equal(r.Name, 'Vanguard 1');
  assert.equal(r.Status, 'O');
  assert.equal(r.State, 'US');
});

test('extracts the snapshot date from the # Updated line', () => {
  assert.equal(parseGcatCatalog(FIXTURE).snapshotDate, '2026 Jul  3 2203:53');
});

test('skips HTML lines, comment lines, short lines, and non-JCAT rows', () => {
  const cat = parseGcatCatalog(FIXTURE);
  const jcats = cat.rows.map((r) => r.JCAT);
  assert.deepEqual(jcats, ['S00005', 'S12345', 'S99999']);
});

test('throws loudly when the header is missing', () => {
  assert.throws(() => parseGcatCatalog('<PRE>\nno header here\n</PRE>'), /no header/);
});

test('cleanCode: missing markers, uncertainty flag stripping', () => {
  assert.deepEqual(cleanCode('US'), { value: 'US', uncertain: false });
  assert.deepEqual(cleanCode('GSFC?'), { value: 'GSFC', uncertain: true });
  assert.deepEqual(cleanCode('-'), { value: null, uncertain: false });
  assert.deepEqual(cleanCode(''), { value: null, uncertain: false });
  assert.deepEqual(cleanCode(undefined), { value: null, uncertain: false });
  assert.deepEqual(cleanCode('?'), { value: null, uncertain: true });
});

test('cleanNum: embedded ? flags, missing markers, non-numeric', () => {
  assert.equal(cleanNum('2000  ?'), 2000);
  assert.equal(cleanNum('13.5'), 13.5);
  assert.equal(cleanNum('-'), null);
  assert.equal(cleanNum(''), null);
  assert.equal(cleanNum('Cyl'), null);
});

test('yearOf: vague dates of varying precision', () => {
  assert.equal(yearOf('1998 Nov 20 0649:47'), 1998);
  assert.equal(yearOf('2026 Jul  3'), 2026);
  assert.equal(yearOf('1957'), 1957);
  assert.equal(yearOf(null), null);
});
