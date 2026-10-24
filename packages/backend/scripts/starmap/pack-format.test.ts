// SPIKE — not production. Tests for the browser pack row format and the day-rebuild / live-delta rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowFromCatalog, rowToLine, lineToRow, parseRows, rowsToText, rowToOmm, reconstructDay, applyLiveDelta, type ElsetRow } from './pack-format.js';

const omm = (norad: number, epoch: string, mm = 15.5): Record<string, unknown> => ({
  OBJECT_NAME: 'X', OBJECT_ID: '1998-067A', EPOCH: epoch, MEAN_MOTION: mm, ECCENTRICITY: 0.0006788, INCLINATION: 51.633, RA_OF_ASC_NODE: 34.3901,
  ARG_OF_PERICENTER: 291.8713, MEAN_ANOMALY: 68.1553, BSTAR: 1e-7, MEAN_MOTION_DOT: 0.00009419, MEAN_MOTION_DDOT: 0, NORAD_CAT_ID: norad,
});
const rec = (norad: number, epoch: string): ElsetRow => rowFromCatalog({ noradId: norad, omm: omm(norad, epoch) }, false);

test('row text round-trips to the identical numbers', () => {
  const r = rowFromCatalog({ noradId: 25544, name: 'ISS (ZARYA)', omm: omm(25544, '2026-10-21T15:05:07.476000Z'), objectType: 'satellite', regime: 'LEO', countryCode: 'ISS' }, true);
  const back = lineToRow(rowToLine(r));
  assert.deepEqual(back, r);
  const o = rowToOmm(back);
  assert.equal(o.BSTAR, 1e-7);
  assert.equal(o.MEAN_MOTION, 15.5);
  assert.equal(o.NORAD_CAT_ID, 25544);
  assert.deepEqual(parseRows(rowsToText([r, r])), [r, r]);
});

test('reconstructDay keeps the newest set per object inside the 30 day span and day end', () => {
  const sets = [rec(1, '2026-09-01T00:00:00Z'), rec(1, '2026-10-10T12:00:00Z'), rec(1, '2026-10-12T12:00:00Z'), rec(2, '2026-09-05T00:00:00Z'), rec(3, '2026-10-11T23:59:59Z')];
  const d = reconstructDay(sets, Date.parse('2026-10-11T00:00:00Z'));
  assert.deepEqual(d.map((r) => [r.norad, r.epoch]), [[1, '2026-10-10T12:00:00Z'], [3, '2026-10-11T23:59:59Z']]); // 2 is older than 30 d, 1's 10-12 set is in the future
});

test('applyLiveDelta replaces, adds and removes by norad, sorted', () => {
  const base = [rec(1, '2026-10-01T00:00:00Z'), rec(2, '2026-10-01T00:00:00Z'), rec(3, '2026-10-01T00:00:00Z')];
  const out = applyLiveDelta(base, [rec(2, '2026-10-02T00:00:00Z'), rec(9, '2026-10-02T00:00:00Z')], [3]);
  assert.deepEqual(out.map((r) => [r.norad, r.epoch]), [[1, '2026-10-01T00:00:00Z'], [2, '2026-10-02T00:00:00Z'], [9, '2026-10-02T00:00:00Z']]);
});
