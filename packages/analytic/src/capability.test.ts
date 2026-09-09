// ============================================================
// Analytic IR v1 — capability/routing tests (P3 S0, spec:
// my_plans/marvin/p3/S0_contracts_registry.md "Tests" #1-4).
// ============================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIELD_REGISTRY } from './schema.js';
import {
  CLIENT_UNSERVED_FIELDS,
  CLIENT_SERVED_FIELDS,
  collectProgramRefs,
  programNeedsServer,
} from './capability.js';
import type { AnalyticProgram } from './types.js';
// NOTE: importing golden.test.ts re-registers (and re-runs) its own it()/describe()
// blocks in this file's test process — harmless (pure validation, idempotent) but
// shows up as duplicate test names in the runner's output. Accepted for S0; revisit
// if it starts to matter (e.g. extract corpus data into a non-test module).
import { GOLDEN_VALID } from './golden.test.js';

describe('capability — CLIENT_UNSERVED_FIELDS', () => {
  it('every unserved name exists in FIELD_REGISTRY (typo guard)', () => {
    for (const f of CLIENT_UNSERVED_FIELDS) {
      assert.ok(f in FIELD_REGISTRY, `${f} is not a real FIELD_REGISTRY key`);
    }
  });

  it('CLIENT_SERVED_FIELDS is the registry minus the unserved set', () => {
    const registryKeys = new Set(Object.keys(FIELD_REGISTRY));
    for (const f of registryKeys) {
      const served = CLIENT_SERVED_FIELDS.has(f);
      const unserved = CLIENT_UNSERVED_FIELDS.has(f);
      assert.notEqual(served, unserved, `${f} must be exactly one of served/unserved`);
    }
  });
});

function baseProgram(over: Partial<AnalyticProgram>): AnalyticProgram {
  return {
    v: 1,
    universe: 'live',
    timeBinding: { mode: 'now' },
    interpretation: 'test',
    pipeline: [],
    output: { shape: 'ids' },
    ...over,
  };
}

describe('capability — collectProgramRefs', () => {
  it('finds fields+fns across filter/derive/sort/output.columns/compare', () => {
    const program = baseProgram({
      pipeline: [
        { op: 'filter', where: { op: '>', args: [{ field: 'meanMotion' }, { lit: 0 }] } },
        { op: 'derive', fields: { elev: { fn: 'elevationDeg', observer: 'user' } } },
        { op: 'sort', by: 'elev', dir: 'desc' },
      ],
      compare: {
        label: 'cmp',
        pipeline: [{ op: 'filter', where: { fn: 'descendsFrom', ancestor: 1 } }],
      },
      output: { shape: 'table', columns: ['name', 'apogeeKm'] },
    });
    const refs = collectProgramRefs(program);
    assert.ok(refs.fields.has('meanMotion'));
    assert.ok(refs.fields.has('name'));
    assert.ok(refs.fields.has('apogeeKm'));
    assert.ok(refs.fns.has('elevationDeg'));
    assert.ok(refs.fns.has('descendsFrom'));
    // 'elev' is derive-local — never counted as a source field.
    assert.ok(!refs.fields.has('elev'));
  });

  it('finds groupBy/aggregate field+fn refs, and excludes post-group column names (agg outputs are computed, not source fields)', () => {
    const program = baseProgram({
      pipeline: [
        { op: 'groupBy', key: ['countryCode', 'launchYear'], aggs: { avgMass: { fn: 'avg', of: 'totMassKg' } } },
        { op: 'sort', by: 'avgMass', dir: 'desc' },
      ],
      output: { shape: 'grouped' },
    });
    const refs = collectProgramRefs(program);
    assert.ok(refs.fields.has('countryCode'));
    assert.ok(refs.fields.has('launchYear'));
    assert.ok(refs.fields.has('totMassKg'));
    // 'avgMass' is a computed agg output, referenced by the post-group sort —
    // it must never be mistaken for an unserved source field.
    assert.ok(!refs.fields.has('avgMass'));
  });

  it('output.columns is still checked against the MAIN pipeline group state, not left clobbered by an aggregating compare pipeline', () => {
    // Regression: inGroupMode was reset to false before walking compare.pipeline
    // but never restored afterward, so if compare aggregates, the output.columns
    // check below (gated on inGroupMode) was wrongly skipped — silently dropping
    // a client-unserved field from the routing check (a "hollow answer" bug).
    const program = baseProgram({
      pipeline: [
        { op: 'filter', where: { op: '>', args: [{ field: 'meanMotion' }, { lit: 0 }] } },
      ],
      compare: {
        label: 'cmp',
        pipeline: [
          { op: 'groupBy', key: 'countryCode', aggs: { n: { fn: 'count' } } },
        ],
      },
      output: { shape: 'table', columns: ['name', 'launchMassKg'] },
    });
    const refs = collectProgramRefs(program);
    assert.ok(refs.fields.has('launchMassKg'));
    assert.equal(programNeedsServer(program), true);
  });

  it('a timeScan predicate contributes its field refs', () => {
    const program = baseProgram({
      pipeline: [
        { op: 'pick', ids: [25544] },
        { op: 'timeScan', predicate: { op: 'not', arg: { field: 'eclipsed' } }, direction: 'forward', stepMinutes: 1, maxSteps: 10 },
      ],
      output: { shape: 'scalar' },
    });
    assert.ok(collectProgramRefs(program).fields.has('eclipsed'));
  });

  it('a sweep predicate AND peakOf both contribute field/fn refs', () => {
    const program = baseProgram({
      pipeline: [
        { op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } },
        {
          op: 'sweep',
          predicate: { op: '>', args: [{ fn: 'elevationDeg', observer: 'user' }, { lit: 10 }] },
          horizonMinutes: 60,
          stepSeconds: 30,
          peakOf: { field: 'launchMassKg' },
        },
      ],
      output: { shape: 'grouped' },
    });
    const refs = collectProgramRefs(program);
    assert.ok(refs.fields.has('regime'));
    assert.ok(refs.fns.has('elevationDeg'));
    // peakOf is a SEPARATE expression from predicate — must be walked too, or a
    // server-only peakOf field would silently route client-side and read null.
    assert.ok(refs.fields.has('launchMassKg'));
  });
});

describe('capability — programNeedsServer', () => {
  it('false for a pure-client program (regime filter -> ids)', () => {
    const program = baseProgram({
      pipeline: [{ op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } }],
    });
    assert.equal(programNeedsServer(program), false);
  });

  it("true for universe 'all'", () => {
    const program = baseProgram({ universe: 'all' });
    assert.equal(programNeedsServer(program), true);
  });

  it('true for a client-unserved field ref (launchMassKg)', () => {
    const program = baseProgram({
      pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'launchMassKg' }, { lit: 0 }] } }],
    });
    assert.equal(programNeedsServer(program), true);
  });

  it('true for a client-unserved fn ref (descendsFrom)', () => {
    const program = baseProgram({
      pipeline: [{ op: 'filter', where: { fn: 'descendsFrom', ancestor: 13552 } }],
    });
    assert.equal(programNeedsServer(program), true);
  });

  it('false for a plain client-servable sweep (elevationDeg pass over an observer)', () => {
    const program = baseProgram({
      pipeline: [
        { op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } },
        {
          op: 'sweep',
          predicate: { op: '>', args: [{ fn: 'elevationDeg', observer: 'user' }, { lit: 10 }] },
          horizonMinutes: 60,
          stepSeconds: 30,
        },
      ],
      output: { shape: 'grouped' },
    });
    assert.equal(programNeedsServer(program), false);
  });

  it('true for a sweep whose peakOf reads a server-only field — the field must not be missed just because it is in peakOf, not predicate', () => {
    const program = baseProgram({
      pipeline: [
        { op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } },
        {
          op: 'sweep',
          predicate: { op: '>', args: [{ fn: 'elevationDeg', observer: 'user' }, { lit: 10 }] },
          horizonMinutes: 60,
          stepSeconds: 30,
          peakOf: { field: 'launchMassKg' },
        },
      ],
      output: { shape: 'grouped' },
    });
    assert.equal(programNeedsServer(program), true);
  });

  it('golden-corpus sweep: locks the client/server routing split', () => {
    assert.ok(GOLDEN_VALID.length > 0, 'golden.test.ts did not populate GOLDEN_VALID');
    const split = GOLDEN_VALID
      .map(({ id, program }) => `${id}:${programNeedsServer(program) ? 'server' : 'client'}`)
      .sort();
    assert.deepEqual(split, [
      'A1:client', 'A2:client', 'A3:client', 'A5:client', 'A6:client', 'A7:client', 'A8:client',
      'B1:client',
      'C1:client', 'C2:client', 'C3:client', 'C4:client', 'C5:client', 'C6:client',
      'D2:client', 'D4:client', 'D5:client', 'D7:client', 'D8:server',
      'E1:server', 'E4:client', 'E5:client', 'E6:client',
      'F1:client', 'F3:client', 'F4:client', 'F6:server',
      'G2:client', 'G3:client',
      'I1:client', 'I2:server',
    ].sort());
  });
});
