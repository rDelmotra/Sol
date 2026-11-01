// passedOver: the ground-pass function of the IR — validation, routing (server only), and execution through an optional data-source
// method (null when the source does not serve it).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateProgram } from './validate.js';
import { collectProgramRefs, programNeedsServer, CLIENT_SERVED_FNS } from './capability.js';
import { execute, type AnalyticDataSource } from './execute.js';
import { FN_SPECS } from './schema.js';
import type { AnalyticProgram, PassedOverExpr } from './types.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const base = (where: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1, universe: 'live', timeBinding: { mode: 'now' }, interpretation: 'test', pipeline: [{ op: 'filter', where }], output: { shape: 'ids' }, ...over,
});
const india = (over: Record<string, unknown> = {}) => ({ fn: 'passedOver', region: 'india', from: '2026-10-02T12:00:00.000Z', to: '2026-11-01T12:00:00.000Z', ...over });
const issues = (p: unknown): string[] => { const v = validateProgram(p, { nowMs: NOW }); return v.ok ? [] : v.issues.map((i) => `${i.code} ${i.path} ${i.message}`); };

describe('passedOver — validation', () => {
  it('accepts a named region and a circle, under both universes', () => {
    assert.deepEqual(issues(base(india())), []);
    assert.deepEqual(issues(base(india({ region: { latDeg: 48.85, lonDeg: 2.35, radiusKm: 500 } }))), []);
    assert.deepEqual(issues(base(india(), { universe: 'all' })), []);
    assert.equal(FN_SPECS.passedOver!.returns, 'bool');
  });
  it('is a boolean: usable in and / not, not as a number', () => {
    assert.deepEqual(issues(base({ op: 'and', args: [india(), { op: 'in', field: 'program', values: ['starlink'] }] })), []);
    assert.deepEqual(issues(base({ op: 'not', arg: india() })), []);
    assert.ok(issues(base({ op: '+', args: [india(), { lit: 1 }] })).length > 0);
  });
  it('rejects an unknown region, a bad circle, a polar circle, and non-ISO / reversed / too long windows', () => {
    assert.match(issues(base(india({ region: 'atlantis' })))[0]!, /unknown region 'atlantis'/);
    assert.ok(issues(base(india({ region: 42 }))).length);
    assert.ok(issues(base(india({ region: { latDeg: 100, lonDeg: 0, radiusKm: 100 } }))).length);
    assert.ok(issues(base(india({ region: { latDeg: 10, lonDeg: 0, radiusKm: 2 } }))).length);
    assert.ok(issues(base(india({ region: { latDeg: 10, lonDeg: 0, radiusKm: 9999 } }))).length);
    assert.match(issues(base(india({ region: { latDeg: 88, lonDeg: 0, radiusKm: 500 } })))[0]!, /85 degrees/);
    assert.match(issues(base(india({ from: 'last week' })))[0]!, /from must be an ISO/);
    assert.match(issues(base(india({ to: 5 })))[0]!, /to must be an ISO/);
    assert.match(issues(base(india({ from: '2026-11-01T12:00:00Z', to: '2026-10-01T12:00:00Z' })))[0]!, /before/);
    assert.match(issues(base(india({ from: '2026-06-01T00:00:00Z' })))[0]!, /at most 90 days/);
  });
});

describe('passedOver — routing', () => {
  const program = (where: unknown): AnalyticProgram => {
    const v = validateProgram(base(where), { nowMs: NOW });
    assert.equal(v.ok, true);
    return (v as { ok: true; program: AnalyticProgram }).program;
  };
  it('is never client-served: a program that uses it goes to the server', () => {
    assert.equal(CLIENT_SERVED_FNS.has('passedOver'), false);
    const p = program(india());
    assert.ok(collectProgramRefs(p).fns.has('passedOver'));
    assert.equal(programNeedsServer(p), true);
    assert.equal(programNeedsServer(program({ op: 'in', field: 'program', values: ['starlink'] })), false);
  });
});

describe('passedOver — execution', () => {
  const ids = [10, 11, 12, 13];
  const source = (served: boolean): AnalyticDataSource => ({
    size: () => ids.length, noradId: (i) => ids[i]!, noradToIndex: (id) => ids.indexOf(id) < 0 ? undefined : ids.indexOf(id),
    getField: (i, f) => (f === 'noradId' ? ids[i]! : f === 'program' ? (i < 2 ? 'starlink' : 'other') : null),
    elevationDeg: () => null, rangeKm: () => null, observerDark: () => null, visuallyVisible: () => null, distToKm: () => null, descendsFrom: () => false,
    ...(served ? { passedOver: (i: number, spec: PassedOverExpr) => (spec.region === 'india' ? i % 2 === 0 : null) } : {}),
  });
  const run = (where: unknown, src: AnalyticDataSource) => {
    const v = validateProgram(base(where), { nowMs: NOW });
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    const out = execute(v.program, { live: src }, { nowMs: NOW });
    if (!out.ok) throw new Error(JSON.stringify(out.error));
    return [...(out.result.ids ?? [])];
  };
  it('filters by the source\'s answer; combines with other filters; not() inverts', () => {
    assert.deepEqual(run(india(), source(true)), [10, 12]);
    assert.deepEqual(run({ op: 'and', args: [india(), { op: 'in', field: 'program', values: ['starlink'] }] }, source(true)), [10]);
    assert.deepEqual(run({ op: 'not', arg: india() }, source(true)), [11, 13]);
  });
  it('a source that does not serve it (or has no answer) matches nothing, never everything', () => {
    assert.deepEqual(run(india(), source(false)), []);
    assert.deepEqual(run(india({ region: 'japan' }), source(true)), []);
  });
});

describe('passedOver — program refs', () => {
  it('collectProgramRefs hands the fn expressions (arguments included) to the server', () => {
    const v = validateProgram(base({ op: 'and', args: [india(), india({ region: { latDeg: 35.7, lonDeg: 139.7, radiusKm: 100 } })] }), { nowMs: NOW });
    assert.equal(v.ok, true);
    const refs = collectProgramRefs((v as { ok: true; program: AnalyticProgram }).program);
    assert.equal(refs.fnExprs.length, 2);
    assert.deepEqual(refs.fnExprs.map((e) => (e.fn === 'passedOver' ? e.region : null)), ['india', { latDeg: 35.7, lonDeg: 139.7, radiusKm: 100 }]);
  });
});
