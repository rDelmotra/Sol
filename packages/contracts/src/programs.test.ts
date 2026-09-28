import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROGRAM_IDS, PROGRAM_LABELS, programLabel } from './programs.js';

describe('programLabel', () => {
  it('returns the display label for every known program id', () => {
    for (const id of PROGRAM_IDS) assert.equal(programLabel(id), PROGRAM_LABELS[id]);
  });

  it('falls back to the slug itself for an id outside the table', () => {
    assert.equal(programLabel('not-a-real-program'), 'not-a-real-program');
  });

  it('PROGRAM_IDS covers every key exactly once', () => {
    assert.deepEqual([...PROGRAM_IDS].sort(), Object.keys(PROGRAM_LABELS).sort());
    assert.equal(new Set(PROGRAM_IDS).size, PROGRAM_IDS.length);
  });
});
