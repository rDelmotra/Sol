// P2/S3 — compile route helper tests (my_plans/marvin/perceptor_p2_plan.md S3).
// Covers the guards + outcome→HTTP mapping without any network round-trip.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateQuestion, outcomeToHttp } from '../../src/routes/query.js';
import type { CompileOutcome } from '../../src/services/analytic-compiler.js';

const PROGRAM = {
  v: 1 as const,
  universe: 'live' as const,
  timeBinding: { mode: 'now' as const },
  interpretation: 'x',
  pipeline: [],
  output: { shape: 'ids' as const },
};

describe('validateQuestion', () => {
  it('rejects non-strings', () => {
    assert.equal(validateQuestion(undefined).ok, false);
    assert.equal(validateQuestion(42).ok, false);
  });

  it('rejects too-short / too-long after trim', () => {
    assert.equal(validateQuestion('  a  ').ok, false);
    assert.equal(validateQuestion('x'.repeat(301)).ok, false);
  });

  it('accepts and trims a normal question', () => {
    const r = validateQuestion('  how many are in shadow  ');
    assert.ok(r.ok && r.question === 'how many are in shadow');
  });
});

describe('outcomeToHttp', () => {
  it('ok → 200 with program', () => {
    const o: CompileOutcome = { ok: true, program: PROGRAM, interpretation: 'x', cached: false, tookMs: 5 };
    const { status, body } = outcomeToHttp(o);
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, program: PROGRAM, interpretation: 'x', cached: false });
  });

  it('refused → 200 (a successful "no")', () => {
    const o: CompileOutcome = { ok: false, kind: 'refused', code: 'OFF_DOMAIN', reason: 'nope', cached: true };
    const { status, body } = outcomeToHttp(o);
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: false, refused: true, code: 'OFF_DOMAIN', reason: 'nope', cached: true });
  });

  it('invalid → 422 with issues', () => {
    const issues = [{ code: 'V-ENUM' as const, path: 'p', message: 'm' }];
    const { status, body } = outcomeToHttp({ ok: false, kind: 'invalid', issues });
    assert.equal(status, 422);
    assert.deepEqual(body, { ok: false, issues });
  });

  it('unavailable → 503', () => {
    const { status, body } = outcomeToHttp({ ok: false, kind: 'unavailable' });
    assert.equal(status, 503);
    assert.deepEqual(body, { ok: false, error: 'Compiler unavailable (no model configured).' });
  });
});
