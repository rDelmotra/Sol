// ============================================================
// ResidentSet tests (P2). Hand-written fake `runProgram` throughout — never a
// real live source or worker, per the task brief. Covers: stable structural
// hashing, budget enforcement at add() time, basic lifecycle, enter/exit
// diffing across ticks, ring-buffer eviction, and — the CRITICAL section —
// that a throwing resident (or a notReady/runtime-error/non-ids outcome)
// can never propagate out of tick() or block the other residents. This last
// group is the one that matters most: SatellitesLayer is the only `critical:
// true` layer, and tick() runs inside its worker-tick callback.
// ============================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AnalyticProgram, ExecuteOutcome } from '@orbitwatch/analytic';
import { ResidentSet, hashProgram, type RunProgramFn } from './ResidentSet.js';

function baseProgram(over?: Partial<AnalyticProgram>): AnalyticProgram {
  return {
    v: 1,
    universe: 'live',
    timeBinding: { mode: 'now' },
    interpretation: 'test resident',
    pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'meanMotion' }, { lit: 0 }] } }],
    output: { shape: 'ids' },
    ...over,
  };
}

/** A timeScan-carrying program — its own `pick` seed keeps successive calls
 *  structurally distinct (different hash) so budget tests don't collide via
 *  the idempotent-add path. */
function timeScanProgram(seedId: number): AnalyticProgram {
  return baseProgram({
    interpretation: `timescan-${seedId}`,
    pipeline: [
      { op: 'pick', ids: [seedId] },
      {
        op: 'timeScan',
        predicate: { op: '>', args: [{ field: 'elevationDeg' }, { lit: 0 }] },
        direction: 'forward',
        stepMinutes: 5,
        maxSteps: 10,
      },
    ],
    output: { shape: 'scalar' },
  });
}

/** A sweep-carrying program — same seeding trick as `timeScanProgram`. Budget
 *  classification is asserted to match timeScan's (see ResidentSet.ts's
 *  `classifyBudget` doc: sweep is far more expensive than a plain
 *  filter/aggregate resident, so it shares the SAME tight class/cap). */
function sweepProgram(seedId: number): AnalyticProgram {
  return baseProgram({
    interpretation: `sweep-${seedId}`,
    pipeline: [
      { op: 'pick', ids: [seedId] },
      {
        op: 'sweep',
        predicate: { op: '>', args: [{ field: 'elevationDeg' }, { lit: 10 }] },
        horizonMinutes: 60,
        stepSeconds: 30,
      },
    ],
    output: { shape: 'grouped' },
  });
}

function idsResult(ids: number[]): ExecuteOutcome {
  return {
    ok: true,
    result: {
      shape: 'ids',
      ids: Uint32Array.from(ids),
      meta: {
        interpretation: 'test',
        universe: 'live',
        evaluatedAt: new Date(0).toISOString(),
        matched: ids.length,
        scanned: ids.length,
        coverage: [],
      },
    },
  };
}

// ── hashProgram: stable structural hashing ─────────────────────────────────

describe('hashProgram — stable structural hashing', () => {
  it('hashes structurally-equal programs identically regardless of key order', () => {
    const a: AnalyticProgram = {
      v: 1,
      universe: 'live',
      timeBinding: { mode: 'now' },
      interpretation: 'x',
      pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'meanMotion' }, { lit: 0 }] } }],
      output: { shape: 'ids' },
    };
    // Same content, every object's keys written in reverse/shuffled order —
    // including the nested `output` and the `filter` stage's `where` expr.
    const b: AnalyticProgram = {
      output: { shape: 'ids' },
      pipeline: [{ where: { args: [{ field: 'meanMotion' }, { lit: 0 }], op: '>' }, op: 'filter' }],
      interpretation: 'x',
      timeBinding: { mode: 'now' },
      universe: 'live',
      v: 1,
    };
    assert.equal(hashProgram(a), hashProgram(b));
  });

  it('hashes a nested-object key reorder (timeBinding) identically', () => {
    const a: AnalyticProgram = baseProgram({ timeBinding: { mode: 'at', t: '2026-01-01T00:00:00Z' } });
    const b: AnalyticProgram = baseProgram({ timeBinding: { t: '2026-01-01T00:00:00Z', mode: 'at' } });
    assert.equal(hashProgram(a), hashProgram(b));
  });

  it('hashes genuinely different programs differently', () => {
    const a = baseProgram({ interpretation: 'alpha' });
    const b = baseProgram({ interpretation: 'beta' });
    assert.notEqual(hashProgram(a), hashProgram(b));
  });

  it('does NOT use raw JSON.stringify key order as its hash input (regression guard)', () => {
    // If the implementation regressed to JSON.stringify(program) directly, these
    // two would hash differently because JSON.stringify preserves insertion order.
    const a: AnalyticProgram = { v: 1, universe: 'live', timeBinding: { mode: 'now' }, interpretation: 'z', pipeline: [], output: { shape: 'ids' } };
    const b: AnalyticProgram = { universe: 'live', v: 1, output: { shape: 'ids' }, pipeline: [], timeBinding: { mode: 'now' }, interpretation: 'z' };
    assert.notEqual(JSON.stringify(a), JSON.stringify(b)); // sanity: raw stringify WOULD differ
    assert.equal(hashProgram(a), hashProgram(b)); // ours does not
  });
});

// ── add(): budget enforcement ────────────────────────────────────────────────

describe("ResidentSet.add — universe:'all' rejection", () => {
  it("rejects universe:'all' with a typed reason, never throws, adds nothing", () => {
    const rs = new ResidentSet();
    const res = rs.add(baseProgram({ universe: 'all' }));
    assert.equal(res.ok, false);
    if (res.ok) throw new Error('expected rejection');
    assert.equal(res.reason, 'universe-all');
    assert.equal(typeof res.message, 'string');
    assert.equal(rs.size, 0);
  });
});

describe('ResidentSet.add — timeScan budget (cap 2)', () => {
  it('accepts up to 2 concurrent timeScan residents, rejects the 3rd', () => {
    const rs = new ResidentSet();
    const r1 = rs.add(timeScanProgram(1));
    const r2 = rs.add(timeScanProgram(2));
    const r3 = rs.add(timeScanProgram(3));
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, false);
    if (r3.ok) throw new Error('expected rejection');
    assert.equal(r3.reason, 'timescan-cap');
    assert.equal(rs.size, 2);
  });

  it('classifies a timeScan stage inside compare.pipeline the same way', () => {
    const rs = new ResidentSet();
    const program = baseProgram({
      compare: {
        label: 'cmp',
        pipeline: [
          { op: 'pick', ids: [9] },
          {
            op: 'timeScan',
            predicate: { op: '>', args: [{ field: 'elevationDeg' }, { lit: 0 }] },
            direction: 'forward',
            stepMinutes: 1,
            maxSteps: 1,
          },
        ],
      },
    });
    const res = rs.add(program);
    assert.equal(res.ok, true);
    const info = rs.list()[0];
    assert.equal(info.budgetClass, 'timeScan');
  });
});

describe('ResidentSet.add — sweep draws from the SAME budget class as timeScan (P3 sweep)', () => {
  it("classifies a sweep-carrying program as budgetClass 'timeScan'", () => {
    const rs = new ResidentSet();
    const res = rs.add(sweepProgram(1));
    assert.equal(res.ok, true);
    assert.equal(rs.list()[0].budgetClass, 'timeScan');
  });

  it('classifies a sweep stage inside compare.pipeline the same way', () => {
    const rs = new ResidentSet();
    const program = baseProgram({
      compare: {
        label: 'cmp',
        pipeline: [
          { op: 'pick', ids: [9] },
          {
            op: 'sweep',
            predicate: { op: '>', args: [{ field: 'elevationDeg' }, { lit: 10 }] },
            horizonMinutes: 60,
            stepSeconds: 30,
          },
        ],
      },
    });
    const res = rs.add(program);
    assert.equal(res.ok, true);
    assert.equal(rs.list()[0].budgetClass, 'timeScan');
  });

  it('sweep and timeScan share ONE pool (cap 2 total), not two separate pools', () => {
    const rs = new ResidentSet();
    const r1 = rs.add(timeScanProgram(1));
    const r2 = rs.add(sweepProgram(2));
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(rs.size, 2);

    // A 3rd of EITHER kind must be rejected — proves they draw from the same
    // cap, not "2 timeScan + 2 sweep" separately.
    const r3sweep = rs.add(sweepProgram(3));
    assert.equal(r3sweep.ok, false);
    if (r3sweep.ok) throw new Error('expected rejection');
    assert.equal(r3sweep.reason, 'timescan-cap');

    const r3scan = rs.add(timeScanProgram(4));
    assert.equal(r3scan.ok, false);
    if (r3scan.ok) throw new Error('expected rejection');
    assert.equal(r3scan.reason, 'timescan-cap');

    assert.equal(rs.size, 2);
  });
});

describe('ResidentSet.add — free-program budget (cap 4)', () => {
  // The cap is 4, not the plan's originally-assumed 32: a live benchmark against
  // the real 32,393-object catalog measured ~6 ms per plain resident per tick,
  // not the assumed sub-millisecond. See the FREE_RESIDENT_CAP comment in
  // ResidentSet.ts for the full numbers and the round-robin time-budget that
  // should replace this count if the ceiling ever needs raising.
  const FREE_CAP = 4;

  it(`accepts up to ${FREE_CAP} plain residents, rejects the next one`, () => {
    const rs = new ResidentSet();
    for (let i = 0; i < FREE_CAP; i++) {
      const res = rs.add(baseProgram({ interpretation: `free-${i}` }));
      assert.equal(res.ok, true, `resident ${i} should have been accepted`);
    }
    assert.equal(rs.size, FREE_CAP);

    const overflow = rs.add(baseProgram({ interpretation: `free-${FREE_CAP}` }));
    assert.equal(overflow.ok, false);
    if (overflow.ok) throw new Error('expected rejection');
    assert.equal(overflow.reason, 'total-cap');
    assert.equal(rs.size, FREE_CAP);
  });
});

describe('ResidentSet.add — idempotency', () => {
  it('adding a structurally-identical program twice returns the same hash and does not double-count', () => {
    const rs = new ResidentSet();
    const r1 = rs.add(baseProgram());
    const r2 = rs.add(baseProgram()); // a fresh object, same content
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    if (!r1.ok || !r2.ok) throw new Error('expected both to succeed');
    assert.equal(r1.hash, r2.hash);
    assert.equal(rs.size, 1);
  });
});

// ── basic lifecycle ──────────────────────────────────────────────────────────

describe('ResidentSet — basic lifecycle', () => {
  it('remove() drops by hash; unknown hash returns false', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram());
    if (!add.ok) throw new Error('setup failed');
    assert.equal(rs.size, 1);
    assert.equal(rs.remove('does-not-exist'), false);
    assert.equal(rs.remove(add.hash), true);
    assert.equal(rs.size, 0);
    assert.equal(rs.remove(add.hash), false); // already gone
  });

  it('clear() drops every resident but leaves the delta ring intact', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram());
    if (!add.ok) throw new Error('setup failed');
    rs.tick(() => idsResult([1]), 1000);
    rs.clear();
    assert.equal(rs.size, 0);
    assert.equal(rs.getRecentDeltas().length, 1); // history of what happened survives
  });
});

// ── tick(): enter/exit diffing ───────────────────────────────────────────────

describe('ResidentSet.tick — enter/exit diffing across successive ticks', () => {
  it('reports the initial membership as "entered", then tracks changes, then goes quiet', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram());
    if (!add.ok) throw new Error('setup failed');

    const frames = [[1, 2, 3], [2, 3, 4], [2, 3, 4], [4]];
    let call = 0;
    const runProgram: RunProgramFn = () => idsResult(frames[call++]);

    const d1 = rs.tick(runProgram, 1000);
    assert.equal(d1.length, 1);
    assert.deepEqual(d1[0], { t: 1000, programHash: add.hash, entered: [1, 2, 3], exited: [] });

    const d2 = rs.tick(runProgram, 2000);
    assert.equal(d2.length, 1);
    assert.deepEqual(d2[0].entered, [4]);
    assert.deepEqual(d2[0].exited, [1]);

    // Same membership as last tick → quiet.
    const d3 = rs.tick(runProgram, 3000);
    assert.deepEqual(d3, []);

    const d4 = rs.tick(runProgram, 4000);
    assert.equal(d4.length, 1);
    assert.deepEqual(d4[0].entered, []);
    assert.deepEqual(d4[0].exited, [2, 3]);
  });

  it('a fully quiet tick (identical ids, unrelated resident untouched) returns []', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram());
    if (!add.ok) throw new Error('setup failed');
    rs.tick(() => idsResult([5, 6]), 1000);
    const quiet = rs.tick(() => idsResult([5, 6]), 2000);
    assert.deepEqual(quiet, []);
    assert.equal(rs.getRecentDeltas().length, 1); // only the first (non-quiet) tick logged
  });

  it('diffs each resident independently in the same tick', () => {
    const rs = new ResidentSet();
    const a = rs.add(baseProgram({ interpretation: 'A' }));
    const b = rs.add(baseProgram({ interpretation: 'B' }));
    if (!a.ok || !b.ok) throw new Error('setup failed');

    rs.tick((p) => idsResult(p.interpretation === 'A' ? [1] : [100]), 1000);
    const deltas = rs.tick((p) => idsResult(p.interpretation === 'A' ? [1, 2] : [100]), 2000);

    assert.equal(deltas.length, 1); // only A changed
    assert.equal(deltas[0].programHash, a.hash);
    assert.deepEqual(deltas[0].entered, [2]);
  });
});

describe('ResidentSet.tick — ring buffer', () => {
  it('caps retained deltas at 1000, evicting the oldest first', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram());
    if (!add.ok) throw new Error('setup failed');

    let toggle = false;
    const runProgram: RunProgramFn = () => {
      toggle = !toggle;
      return idsResult(toggle ? [1] : [2]); // changes EVERY tick → never quiet
    };

    const TOTAL = 1005;
    for (let t = 0; t < TOTAL; t++) {
      const out = rs.tick(runProgram, t);
      assert.equal(out.length, 1);
    }

    const all = rs.getRecentDeltas();
    assert.equal(all.length, 1000);
    assert.equal(all[0].t, TOTAL - 1000); // oldest 5 (t=0..4) evicted
    assert.equal(all[all.length - 1].t, TOTAL - 1);
  });

  it('getRecentDeltas(n) returns the most recent n in chronological order', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram());
    if (!add.ok) throw new Error('setup failed');

    let toggle = false;
    const runProgram: RunProgramFn = () => {
      toggle = !toggle;
      return idsResult(toggle ? [1] : [2]);
    };
    for (let t = 0; t < 5; t++) rs.tick(runProgram, t);

    const last2 = rs.getRecentDeltas(2);
    assert.equal(last2.length, 2);
    assert.deepEqual(last2.map((d) => d.t), [3, 4]);
  });
});

// ── tick(): CRITICAL — error containment ─────────────────────────────────────

describe('ResidentSet.tick — a throwing resident is contained', () => {
  it('does not propagate out of tick() and does not block other residents', () => {
    const rs = new ResidentSet();
    const bad = rs.add(baseProgram({ interpretation: 'bad' }));
    const good = rs.add(baseProgram({ interpretation: 'good' }));
    if (!bad.ok || !good.ok) throw new Error('setup failed');

    const runProgram: RunProgramFn = (program) => {
      if (program.interpretation === 'bad') throw new Error('boom');
      return idsResult([42]);
    };

    // If tick() lets the throw escape, this call itself fails the test.
    const deltas = rs.tick(runProgram, 1000);
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].programHash, good.hash);

    const badInfo = rs.list().find((e) => e.programHash === bad.hash);
    assert.ok(badInfo, 'the errored resident stays visible via list()');
    assert.equal(badInfo?.erroredMessage, 'boom');

    const goodInfo = rs.list().find((e) => e.programHash === good.hash);
    assert.equal(goodInfo?.erroredMessage, null);
  });

  it('a resident that has errored is permanently skipped, not retried', () => {
    const rs = new ResidentSet();
    const bad = rs.add(baseProgram({ interpretation: 'bad' }));
    if (!bad.ok) throw new Error('setup failed');

    rs.tick(() => {
      throw new Error('first failure');
    }, 1000);
    assert.equal(rs.list()[0].erroredMessage, 'first failure');

    // Second tick: runProgram would throw a DIFFERENT error if called — proves
    // it is never invoked again for this resident.
    let calls = 0;
    const deltas = rs.tick(() => {
      calls++;
      throw new Error('should never be reached');
    }, 2000);
    assert.equal(calls, 0);
    assert.deepEqual(deltas, []);
    assert.equal(rs.list()[0].erroredMessage, 'first failure'); // unchanged
  });

  it('a non-Error throw (e.g. a plain string) is still contained and stringified', () => {
    const rs = new ResidentSet();
    const bad = rs.add(baseProgram());
    if (!bad.ok) throw new Error('setup failed');
    const deltas = rs.tick(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'not an Error object';
    }, 1000);
    assert.deepEqual(deltas, []);
    assert.equal(rs.list()[0].erroredMessage, 'not an Error object');
  });
});

describe('ResidentSet.tick — non-fatal outcomes', () => {
  it('{notReady:true} is skipped without touching lastIds or emitting a delta', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram());
    if (!add.ok) throw new Error('setup failed');

    rs.tick(() => idsResult([1, 2]), 1000); // establish baseline
    const notReadyDeltas = rs.tick(() => ({ notReady: true }), 2000);
    assert.deepEqual(notReadyDeltas, []);
    assert.equal(rs.list()[0].memberCount, 2); // baseline preserved, not wiped

    // Diffs against the PRESERVED baseline, not a wiped-empty one.
    const d3 = rs.tick(() => idsResult([1, 2, 3]), 3000);
    assert.equal(d3.length, 1);
    assert.deepEqual(d3[0].entered, [3]);
    assert.deepEqual(d3[0].exited, []);
  });

  it('{ok:false} (a typed runtime error) is a non-fatal skip, NOT an errored/stopped state', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram());
    if (!add.ok) throw new Error('setup failed');

    rs.tick(() => idsResult([1]), 1000);
    const errDeltas = rs.tick(
      () => ({ ok: false, error: { code: 'E-OBSERVER', message: 'no observer configured' } }),
      2000,
    );
    assert.deepEqual(errDeltas, []);
    assert.equal(rs.list()[0].erroredMessage, null); // NOT marked errored — retried next tick
    assert.equal(rs.list()[0].memberCount, 1);

    // Confirm it really is retried (not accidentally stopped like a throw).
    const d3 = rs.tick(() => idsResult([1, 7]), 3000);
    assert.equal(d3.length, 1);
    assert.deepEqual(d3[0].entered, [7]);
  });

  it('a non-"ids" result shape (e.g. scalar) is a no-op tick, not an error', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram({ output: { shape: 'scalar' } }));
    if (!add.ok) throw new Error('setup failed');

    const scalarOutcome: ExecuteOutcome = {
      ok: true,
      result: {
        shape: 'scalar',
        value: 42,
        meta: {
          interpretation: 'x',
          universe: 'live',
          evaluatedAt: new Date(0).toISOString(),
          matched: 1,
          scanned: 1,
          coverage: [],
        },
      },
    };
    const deltas = rs.tick(() => scalarOutcome, 1000);
    assert.deepEqual(deltas, []);
    assert.equal(rs.list()[0].erroredMessage, null);
    assert.equal(rs.list()[0].memberCount, 0);
  });

  it('an "ids" outcome with an empty array is a valid (not notReady) result and can produce an exit-only delta', () => {
    const rs = new ResidentSet();
    const add = rs.add(baseProgram());
    if (!add.ok) throw new Error('setup failed');

    rs.tick(() => idsResult([1, 2]), 1000);
    const d2 = rs.tick(() => idsResult([]), 2000);
    assert.equal(d2.length, 1);
    assert.deepEqual(d2[0].entered, []);
    assert.deepEqual(d2[0].exited, [1, 2]);
  });
});
