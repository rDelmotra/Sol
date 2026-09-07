// Tests for the GCAT vocabulary tables. The observed-set tests pin the FULL
// distinct code sets found in the 2026-07-03 snapshot — if a future snapshot
// surfaces a new code, the ingest report catches it at build time; if someone
// edits a mapping, these tests catch it here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupGcatStatus,
  lookupGcatType,
  clasToSectors,
  categoryToPurpose,
} from '../../src/enrichment/gcat/vocab.js';

// Every non-blank Status code observed in the 2026-07-03 satcat (22 codes,
// incl. '?'-flagged variants), from the survey census.
const OBSERVED_STATUS = [
  'R', 'O', 'OX', 'L', 'DK', 'DSO', 'N', 'AR', 'D', 'E', 'TFR', 'AO',
  'GRP', 'ATT', 'DSA', 'C', 'ERR', 'R?', 'L?', 'REL', 'EVA DP',
];

test('every observed Status code maps (no silent unknowns in this snapshot)', () => {
  for (const code of OBSERVED_STATUS) {
    assert.notEqual(lookupGcatStatus(code), undefined, `unmapped status: ${code}`);
  }
});

test('status family assignments are doc-verified', () => {
  assert.equal(lookupGcatStatus('O'), 'in_orbit');
  assert.equal(lookupGcatStatus('OX'), 'in_orbit');   // lost but (probably) orbiting
  assert.equal(lookupGcatStatus('DK'), 'in_orbit');   // docked
  assert.equal(lookupGcatStatus('N'), 'in_orbit');    // renamed ≠ never-orbited
  assert.equal(lookupGcatStatus('R'), 'decayed');     // natural reentry
  assert.equal(lookupGcatStatus('D'), 'deorbited');   // active deorbit
  assert.equal(lookupGcatStatus('L'), 'deorbited');   // landed — user-decided fold
  assert.equal(lookupGcatStatus('DSO'), 'beyond_earth');
  assert.equal(lookupGcatStatus('E'), 'exploded');
  assert.equal(lookupGcatStatus('C'), 'exploded');    // collided → destroyed
  assert.equal(lookupGcatStatus('ERR'), 'unknown');   // cataloging error
});

test('status lookup strips one trailing ? and rejects unknowns', () => {
  assert.equal(lookupGcatStatus('R?'), 'decayed');
  assert.equal(lookupGcatStatus('L?'), 'deorbited');
  assert.equal(lookupGcatStatus('ZZZ'), undefined);
  assert.equal(lookupGcatStatus(null), undefined);
});

test('type maps on first char; attribute flags ignored; Z spurious → unknown', () => {
  assert.equal(lookupGcatType('P'), 'payload');
  assert.equal(lookupGcatType('PPTH-MU'), 'payload');   // ISS Zarya's full cell
  assert.equal(lookupGcatType('R3'), 'rocket_body');
  assert.equal(lookupGcatType('CP E-I'), 'component');
  assert.equal(lookupGcatType('D'), 'debris');
  assert.equal(lookupGcatType('Z'), 'unknown');
  assert.equal(lookupGcatType('Q'), undefined);
  assert.equal(lookupGcatType(null), undefined);
});

test('clas: observed set maps fully; combos multi-sector; A folds to civil', () => {
  // Observed Clas values in the 2026-07-03 psatcat: B, D, C, A, CD, BD, CB, BC
  assert.deepEqual(clasToSectors('B').sectors, ['commercial']);
  assert.deepEqual(clasToSectors('D').sectors, ['military']);
  assert.deepEqual(clasToSectors('C').sectors, ['civil']);
  assert.deepEqual(clasToSectors('A').sectors, ['civil']);
  assert.deepEqual(clasToSectors('CD').sectors, ['civil', 'military']);
  assert.deepEqual(clasToSectors('BD').sectors, ['commercial', 'military']);
  assert.deepEqual(clasToSectors('CB').sectors, ['civil', 'commercial']);
  // 'CA' dedupes (both → civil)
  assert.deepEqual(clasToSectors('CA').sectors, ['civil']);
  assert.deepEqual(clasToSectors('B').unknownChars, []);
});

test('clas: unknown chars surface; null/missing → empty', () => {
  const m = clasToSectors('BX');
  assert.deepEqual(m.sectors, ['commercial']);
  assert.deepEqual(m.unknownChars, ['X']);
  assert.deepEqual(clasToSectors(null), { sectors: [], unknownChars: [] });
});

test('category: primary token decides purpose; ?/* flags stripped', () => {
  assert.equal(categoryToPurpose('COM'), 'communications');
  assert.equal(categoryToPurpose('COM/MET-RO'), 'communications');
  assert.equal(categoryToPurpose('IMG-R'), 'earth_observation');
  assert.equal(categoryToPurpose('SIG?*'), 'surveillance');
  assert.equal(categoryToPurpose('EW*'), 'surveillance');
  assert.equal(categoryToPurpose('TECH?'), 'technology_dev');
  assert.equal(categoryToPurpose('MET-RO'), 'meteorological');
  assert.equal(categoryToPurpose('MGRAV'), 'space_science');
  assert.equal(categoryToPurpose('AST'), 'space_observation');
  // explicit 'other' buckets are MAPPED (not unmapped)
  assert.equal(categoryToPurpose('SS'), 'other');
  assert.equal(categoryToPurpose('PLAN/RV'), 'other');
  assert.equal(categoryToPurpose('WEAPON'), 'other');
});

test('category: unknown primary token → undefined (reported by ingest)', () => {
  assert.equal(categoryToPurpose('XYZZY'), undefined);
  assert.equal(categoryToPurpose(null), undefined);
});
