// P2/S3 — compile route helper tests (my_plans/marvin/perceptor_p2_plan.md S3).
// Covers the guards + outcome→HTTP mapping without any network round-trip.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAST_CAP_DAYS, FUTURE_CAP_DAYS } from '@orbitwatch/analytic';
import { validateQuestion, outcomeToHttp, resolveTMs, resolveObserver } from '../../src/routes/query.js';
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

describe('resolveTMs', () => {
  const NOW = Date.parse('2026-07-20T00:00:00Z');
  const MS_PER_DAY = 86_400_000;

  it('absent → nowMs', () => {
    assert.equal(resolveTMs(undefined, NOW), NOW);
  });

  it('garbage (non-finite / non-number) → nowMs', () => {
    assert.equal(resolveTMs(NaN, NOW), NOW);
    assert.equal(resolveTMs(Infinity, NOW), NOW);
    assert.equal(resolveTMs('2026-07-20', NOW), NOW);
    assert.equal(resolveTMs(null, NOW), NOW);
  });

  it('in-window value passes through unchanged', () => {
    const t = NOW + 3 * MS_PER_DAY;
    assert.equal(resolveTMs(t, NOW), t);
  });

  it('clamps past edge to -PAST_CAP_DAYS', () => {
    const tooFarPast = NOW - (PAST_CAP_DAYS + 10) * MS_PER_DAY;
    assert.equal(resolveTMs(tooFarPast, NOW), NOW - PAST_CAP_DAYS * MS_PER_DAY);
  });

  it('clamps future edge to +FUTURE_CAP_DAYS', () => {
    const tooFarFuture = NOW + (FUTURE_CAP_DAYS + 10) * MS_PER_DAY;
    assert.equal(resolveTMs(tooFarFuture, NOW), NOW + FUTURE_CAP_DAYS * MS_PER_DAY);
  });
});

describe('resolveObserver', () => {
  it('valid observer passes through', () => {
    assert.deepEqual(resolveObserver({ latDeg: 51.5, lonDeg: -0.1 }), { latDeg: 51.5, lonDeg: -0.1 });
  });

  it('valid observer with altKm passes through', () => {
    assert.deepEqual(
      resolveObserver({ latDeg: 51.5, lonDeg: -0.1, altKm: 0.05 }),
      { latDeg: 51.5, lonDeg: -0.1, altKm: 0.05 },
    );
  });

  it('edge lat/lon bounds are inclusive', () => {
    assert.deepEqual(resolveObserver({ latDeg: 90, lonDeg: 180 }), { latDeg: 90, lonDeg: 180 });
    assert.deepEqual(resolveObserver({ latDeg: -90, lonDeg: -180 }), { latDeg: -90, lonDeg: -180 });
  });

  it('out-of-range lat/lon → null', () => {
    assert.equal(resolveObserver({ latDeg: 90.1, lonDeg: 0 }), null);
    assert.equal(resolveObserver({ latDeg: 0, lonDeg: 180.1 }), null);
    assert.equal(resolveObserver({ latDeg: -91, lonDeg: 0 }), null);
  });

  it('negative altKm → null', () => {
    assert.equal(resolveObserver({ latDeg: 0, lonDeg: 0, altKm: -1 }), null);
  });

  it('missing altKm is fine (optional)', () => {
    assert.deepEqual(resolveObserver({ latDeg: 0, lonDeg: 0 }), { latDeg: 0, lonDeg: 0 });
  });

  it('garbage → null, never throws', () => {
    assert.equal(resolveObserver(undefined), null);
    assert.equal(resolveObserver(null), null);
    assert.equal(resolveObserver('not an object'), null);
    assert.equal(resolveObserver(42), null);
    assert.equal(resolveObserver({}), null);
    assert.equal(resolveObserver({ latDeg: 'north', lonDeg: 0 }), null);
    assert.equal(resolveObserver({ latDeg: 0, lonDeg: 0, altKm: 'high' }), null);
    assert.equal(resolveObserver({ latDeg: NaN, lonDeg: 0 }), null);
  });
});
