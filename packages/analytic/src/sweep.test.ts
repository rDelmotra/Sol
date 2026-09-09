// ============================================================
// Analytic IR v1 — `sweep` stage tests (P3 sweep brief).
//
// A hand-built fake AnalyticDataSource, purpose-built for sweep: each object's
// elevationDeg(i, obs, tMs) is a KNOWN closed-form function of tMs (a triangle
// wave / linear ramp / oscillator), so AOS/LOS/peak instants are computable by
// hand and asserted with tight tolerances. This is deliberately a SEPARATE
// fixture from execute.test.ts's (which has static, non-time-varying `elev`
// values and can't exercise interval detection). Never a real SGP4 source or
// worker, per the task brief.
// ============================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateProgram,
  SWEEP_MAX_OBJECTS,
  SWEEP_MAX_OBJECT_STEPS,
  SWEEP_MAX_INTERVALS_PER_OBJECT,
  SWEEP_MAX_HORIZON_MINUTES,
  SWEEP_MIN_STEP_SECONDS,
  SWEEP_MAX_STEP_SECONDS,
  type ValidationCode,
} from './validate.js';
import {
  execute,
  footprintHalfAngleDeg,
  type AnalyticDataSource,
  type FieldValue,
} from './execute.js';
import type { AnalyticResult } from './types.js';

const NOW = Date.parse('2026-07-10T12:00:00Z');
const MIN_MS = 60_000;

// ── Fixture: objects with KNOWN, hand-computed elevation-over-time shapes ─────

interface SweepObj {
  noradId: number;
  name: string;
  inclination: number | null;
  apogeeKm: number | null;
  perigeeKm: number | null;
  elev: (tMs: number) => number | null;
  /** Only NULL_PEAK overrides this (always-null, for the "peakOf null everywhere" case). */
  range?: (tMs: number) => number | null;
}

/** peakVal - |t - peakMin| * slope, in minutes-from-NOW. A triangular pass. */
function triangle(peakMinFromT0: number, peakVal: number, slopePerMin: number) {
  return (tMs: number): number => {
    const tMin = (tMs - NOW) / MIN_MS;
    return peakVal - Math.abs(tMin - peakMinFromT0) * slopePerMin;
  };
}

// AOS = 20 - 20/3 = 40/3 min = 800_000 ms; LOS = 20 + 20/3 = 80/3 min = 1_600_000 ms;
// peak = 30 at tMin=20 (t0 + 1_200_000 ms). All exact (20/3*3=20 divides cleanly).
const RISER_ELEV = triangle(20, 30, 3);

function doublePassElev(tMs: number): number {
  const tMin = (tMs - NOW) / MIN_MS;
  const p1 = 20 - Math.abs(tMin - 10) * 2; // AOS 5, LOS 15, peak 20 @ 10 min
  const p2 = 25 - Math.abs(tMin - 40) * 3; // AOS 35, LOS 45, peak 25 @ 40 min
  return Math.max(p1, p2);
}

function openStartElev(tMs: number): number {
  return 50 - (tMs - NOW) / MIN_MS; // crosses 10 at tMin=40, already above 10 at t0
}

function openEndElev(tMs: number): number {
  return (tMs - NOW) / MIN_MS; // crosses 10 at tMin=10, keeps rising past the horizon
}

function oscillatorElev(tMs: number): number {
  // Toggles every coarse step (stepSeconds=60 in its own test) — many short intervals.
  return Math.round((tMs - NOW) / MIN_MS) % 2 === 0 ? 20 : 0;
}

const OBJS: SweepObj[] = [
  { noradId: 100001, name: 'RISER', inclination: 90, apogeeKm: 500, perigeeKm: 500, elev: RISER_ELEV },
  { noradId: 100002, name: 'OPEN_AT_START', inclination: 90, apogeeKm: 500, perigeeKm: 500, elev: openStartElev },
  { noradId: 100003, name: 'OPEN_AT_END', inclination: 90, apogeeKm: 500, perigeeKm: 500, elev: openEndElev },
  { noradId: 100004, name: 'DOUBLE_PASS', inclination: 90, apogeeKm: 500, perigeeKm: 500, elev: doublePassElev },
  { noradId: 100005, name: 'NEVER', inclination: 90, apogeeKm: 500, perigeeKm: 500, elev: () => -50 },
  { noradId: 100006, name: 'NULLZONE', inclination: 90, apogeeKm: 500, perigeeKm: 500, elev: () => null },
  { noradId: 100007, name: 'NULL_PEAK', inclination: 90, apogeeKm: 500, perigeeKm: 500, elev: RISER_ELEV, range: () => null },
  { noradId: 100008, name: 'OSCILLATOR', inclination: 90, apogeeKm: 500, perigeeKm: 500, elev: oscillatorElev },
  // Apogee-vs-perigee discriminator: inclination 10°, apogee 2000 km, perigee 300 km.
  // At observer latDeg=30, ε=10°: using APOGEE keeps it visible (latMax+λ≈41.4°>30°);
  // using PERIGEE (the bug the brief warns about) would wrongly exclude it (≈19.9°<30°).
  { noradId: 100009, name: 'APOGEE_DISCRIMINATOR', inclination: 10, apogeeKm: 2000, perigeeKm: 300, elev: RISER_ELEV },
  // Genuinely excluded from latDeg=30 regardless of apogee/perigee (low inclination,
  // modest altitude) — AND its elevation is honestly always-low, so exclusion changes
  // nothing real.
  { noradId: 100010, name: 'GEOMETRICALLY_EXCLUDED', inclination: 5, apogeeKm: 400, perigeeKm: 350, elev: () => -50 },
  // Null orbital elements must fail SAFE (never pre-filtered out), regardless of how
  // extreme the observer latitude is.
  { noradId: 100011, name: 'NULL_ORBIT_ELEMENTS', inclination: null, apogeeKm: null, perigeeKm: null, elev: RISER_ELEV },
];

function makeSource(objs: SweepObj[]): AnalyticDataSource {
  const byNorad = new Map(objs.map((o, i) => [o.noradId, i]));
  return {
    size: () => objs.length,
    noradId: (i) => objs[i].noradId,
    noradToIndex: (id) => byNorad.get(id),
    getField: (i, field): FieldValue => {
      const o = objs[i];
      switch (field) {
        case 'noradId': return o.noradId;
        case 'name': return o.name;
        case 'inclination': return o.inclination;
        case 'apogeeKm': return o.apogeeKm;
        case 'perigeeKm': return o.perigeeKm;
        case 'regime': return 'LEO';
        default: return null;
      }
    },
    elevationDeg: (i, _obs, tMs) => objs[i].elev(tMs),
    rangeKm: (i, _obs, tMs) => (objs[i].range ? objs[i].range!(tMs) : 1000),
    observerDark: () => true,
    visuallyVisible: () => null,
    distToKm: () => null,
    descendsFrom: () => false,
  };
}

const SOURCE = makeSource(OBJS);
const SOURCES = { live: SOURCE, all: SOURCE };

// ── Harness ───────────────────────────────────────────────────────────────────

function prog(over: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1, universe: 'live', timeBinding: { mode: 'now' },
    interpretation: 'sweep test', output: { shape: 'grouped' }, ...over,
  };
}

function run(p: Record<string, unknown>, opts?: { disablePrefilter?: boolean; sources?: { live: AnalyticDataSource; all?: AnalyticDataSource } }): AnalyticResult {
  const v = validateProgram(p, { nowMs: NOW });
  assert.equal(v.ok, true, v.ok ? '' : `program invalid: ${JSON.stringify(v.issues)}`);
  if (!v.ok) throw new Error('unreachable');
  const out = execute(v.program, opts?.sources ?? SOURCES, { nowMs: NOW, __testDisableSweepPrefilter: opts?.disablePrefilter === true });
  assert.equal(out.ok, true, out.ok ? '' : `runtime error: ${JSON.stringify(out.error)}`);
  if (!out.ok) throw new Error('unreachable');
  return out.result;
}

function elevExpr(latDeg: number, lonDeg: number): Record<string, unknown> {
  return { fn: 'elevationDeg', observer: { latDeg, lonDeg } };
}

function elevGate(latDeg: number, lonDeg: number, thresholdDeg = 10): Record<string, unknown> {
  return { op: '>', args: [elevExpr(latDeg, lonDeg), { lit: thresholdDeg }] };
}

// ── λ formula sanity (pins the geometry — Re = 6371 km) ────────────────────────

describe('sweep — footprintHalfAngleDeg (λ) formula sanity', () => {
  it('ε=0°, h=400 km ⇒ λ ≈ 19.8°', () => {
    assert.ok(Math.abs(footprintHalfAngleDeg(400, 0) - 19.8) < 0.1, String(footprintHalfAngleDeg(400, 0)));
  });

  it('ε=90° ⇒ λ = 0° regardless of altitude', () => {
    assert.ok(Math.abs(footprintHalfAngleDeg(400, 90) - 0) < 1e-6);
    assert.ok(Math.abs(footprintHalfAngleDeg(35786, 90) - 0) < 1e-6); // GEO altitude too
  });

  it('ε=10°, h=400 km ⇒ λ ≈ 12.1°', () => {
    assert.ok(Math.abs(footprintHalfAngleDeg(400, 10) - 12.1) < 0.1, String(footprintHalfAngleDeg(400, 10)));
  });
});

// ── Interval shapes (hand-computed) ─────────────────────────────────────────────

describe('sweep — interval shapes (hand-computed fixtures)', () => {
  it('a clean rise-and-set interval: AOS≈13.33min, LOS≈26.67min, no clipping (RISER)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100001] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    }));
    assert.equal(r.shape, 'grouped');
    assert.equal(r.rows?.length, 1);
    const row = r.rows![0];
    assert.equal(row.noradId, 100001);
    assert.equal(row.clippedEdge, null);
    const startMs = Date.parse(row.startIso as string);
    const endMs = Date.parse(row.endIso as string);
    assert.ok(Math.abs(startMs - (NOW + 800_000)) < 500, `AOS off by ${startMs - (NOW + 800_000)}ms`);
    assert.ok(Math.abs(endMs - (NOW + 1_600_000)) < 500, `LOS off by ${endMs - (NOW + 1_600_000)}ms`);
    assert.ok(Math.abs((row.durationMinutes as number) - 40 / 3) < 0.05);
  });

  it('bisection actually narrows the AOS edge well beyond the 60s coarse step', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100001] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    }));
    const startMs = Date.parse(r.rows![0].startIso as string);
    const trueAosMs = NOW + 800_000;
    const errorMs = Math.abs(startMs - trueAosMs);
    const stepMs = 60_000;
    assert.ok(errorMs < stepMs / 50, `bisection error ${errorMs}ms should be well under the ${stepMs}ms coarse step`);
  });

  it('peakOf finds the hand-computed max (30° at t0+20min)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100001] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60, peakOf: elevExpr(0, 0) },
      ],
    }));
    const row = r.rows![0];
    assert.ok(Math.abs((row.peak as number) - 30) < 0.01, String(row.peak));
    const peakMs = Date.parse(row.peakIso as string);
    assert.ok(Math.abs(peakMs - (NOW + 1_200_000)) < 100, `peak time off by ${peakMs - (NOW + 1_200_000)}ms`);
  });

  it('a sweep with no peakOf omits peak/peakIso entirely (not even null)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100001] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    }));
    assert.equal('peak' in r.rows![0], false);
    assert.equal('peakIso' in r.rows![0], false);
  });

  it('peakOf null everywhere in the interval ⇒ peak:null, peakIso:null (interval itself still reported)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100007] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60, peakOf: { fn: 'rangeKm', observer: { latDeg: 0, lonDeg: 0 } } },
      ],
    }));
    assert.equal(r.rows?.length, 1);
    assert.equal(r.rows![0].peak, null);
    assert.equal(r.rows![0].peakIso, null);
    assert.notEqual(r.rows![0].startIso, undefined);
  });

  it('an interval already open at t0 is marked clippedEdge:"start" (OPEN_AT_START)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100002] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    }));
    assert.equal(r.rows?.length, 1);
    const row = r.rows![0];
    assert.equal(row.clippedEdge, 'start');
    assert.equal(Date.parse(row.startIso as string), NOW);
    const endMs = Date.parse(row.endIso as string);
    assert.ok(Math.abs(endMs - (NOW + 40 * MIN_MS)) < 500);
  });

  it('an interval still open at the horizon is marked clippedEdge:"end" (OPEN_AT_END)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100003] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    }));
    assert.equal(r.rows?.length, 1);
    const row = r.rows![0];
    assert.equal(row.clippedEdge, 'end');
    assert.equal(Date.parse(row.endIso as string), NOW + 60 * MIN_MS);
    const startMs = Date.parse(row.startIso as string);
    assert.ok(Math.abs(startMs - (NOW + 10 * MIN_MS)) < 500);
  });

  it('multiple intervals for one object: two separate rise-and-set windows (DOUBLE_PASS)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100004] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    }));
    assert.equal(r.rows?.length, 2);
    assert.equal(r.rows![0].clippedEdge, null);
    assert.equal(r.rows![1].clippedEdge, null);
    const aos1 = Date.parse(r.rows![0].startIso as string);
    const los1 = Date.parse(r.rows![0].endIso as string);
    const aos2 = Date.parse(r.rows![1].startIso as string);
    const los2 = Date.parse(r.rows![1].endIso as string);
    assert.ok(Math.abs(aos1 - (NOW + 5 * MIN_MS)) < 500);
    assert.ok(Math.abs(los1 - (NOW + 15 * MIN_MS)) < 500);
    assert.ok(Math.abs(aos2 - (NOW + 35 * MIN_MS)) < 500);
    assert.ok(Math.abs(los2 - (NOW + 45 * MIN_MS)) < 500);
  });

  it('zero intervals ⇒ zero rows, not an empty-but-present row (NEVER)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100005] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    }));
    assert.deepEqual(r.rows, []);
  });

  it('a null predicate result is NOT true: an always-null elevationDeg contributes zero rows, never an open interval (NULLZONE)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100006] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    }));
    assert.deepEqual(r.rows, []);
  });
});

// ── Output shape: grouped only ──────────────────────────────────────────────────

describe('sweep — output shape: grouped only', () => {
  it("'grouped' output passes rows straight through, needing no groupBy pipeline", () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100001] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
      output: { shape: 'grouped' },
    }));
    assert.equal(r.shape, 'grouped');
  });

  it("'ids'/'table'/'object' outputs are all rejected for a sweep pipeline (validator, not a runtime crash)", () => {
    for (const shape of ['ids', 'table', 'object'] as const) {
      const p = prog({
        pipeline: [
          { op: 'pick', ids: [100001] },
          { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
        ],
        output: shape === 'table' ? { shape, columns: ['name'] } : { shape },
      });
      const v = validateProgram(p, { nowMs: NOW });
      assert.equal(v.ok, false, `expected '${shape}' output to be rejected for a sweep pipeline`);
    }
  });
});

// ── Runtime bounds (§5): honest clipping, never a silent drop ──────────────────

describe('sweep — runtime bounds (§5)', () => {
  it('caps intervals per object at SWEEP_MAX_INTERVALS_PER_OBJECT and notes it in clipped[] (OSCILLATOR)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [100008] },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 140, stepSeconds: 60 },
      ],
    }));
    assert.equal(r.rows?.length, SWEEP_MAX_INTERVALS_PER_OBJECT);
    assert.ok(r.meta.clipped?.some((m) => m.includes('100008') && m.includes(String(SWEEP_MAX_INTERVALS_PER_OBJECT))));
  });

  it('SWEEP_MAX_OBJECTS: truncates to the first N objects (deterministic) and never silently drops — notes it in clipped[]', () => {
    const N = SWEEP_MAX_OBJECTS + 1; // one over the cap
    const objs: SweepObj[] = [];
    for (let k = 0; k < N; k++) {
      objs.push({
        noradId: 900000 + k,
        name: `BULK_${k}`,
        inclination: 90, apogeeKm: 500, perigeeKm: 500,
        // Every object false EXCEPT the very last (index N-1, past the cap) — proves
        // truncation actually drops a REAL answer, not a coincidentally-empty one.
        elev: k === N - 1 ? () => 50 : () => -50,
      });
    }
    const source = makeSource(objs);
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    }), { sources: { live: source, all: source } });
    assert.deepEqual(r.rows, []); // the one TRUE object was past the cap
    assert.ok(r.meta.clipped?.some((m) => m.includes(String(SWEEP_MAX_OBJECTS))));
  });

  it('N x steps budget: reduces the OBJECT COUNT, never the horizon or step resolution', () => {
    // horizonMinutes=10_080 (max), stepSeconds=5 (min) => 120_960 steps/object.
    const horizonMinutes = SWEEP_MAX_HORIZON_MINUTES;
    const stepSeconds = SWEEP_MIN_STEP_SECONDS;
    const stepsPerObject = Math.ceil((horizonMinutes * 60) / stepSeconds);
    const expectedCap = Math.floor(SWEEP_MAX_OBJECT_STEPS / stepsPerObject);
    assert.ok(expectedCap >= 1 && expectedCap < 6, `test assumption broken: expectedCap=${expectedCap}`);

    const objs: SweepObj[] = [];
    for (let k = 0; k < 6; k++) {
      objs.push({
        noradId: 800000 + k,
        name: `HORIZON_${k}`,
        inclination: 90, apogeeKm: 500, perigeeKm: 500,
        // True only in the last 30s of the FULL 7-day horizon. If the horizon were
        // silently shortened instead of the object count, this would never be found
        // even for a surviving object.
        elev: (tMs) => (tMs >= NOW + horizonMinutes * MIN_MS - 30_000 ? 50 : -50),
      });
    }
    const source = makeSource(objs);
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } },
        { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes, stepSeconds },
      ],
    }), { sources: { live: source, all: source } });

    const norads = new Set((r.rows ?? []).map((row) => row.noradId));
    assert.equal(norads.size, expectedCap);
    for (const id of norads) assert.ok((id as number) < 800000 + expectedCap);
    assert.ok(r.meta.clipped?.some((m) => m.includes(String(SWEEP_MAX_OBJECT_STEPS)) && m.includes(`${horizonMinutes}`)));
  });
});

// ── Geometric pre-filter (§6): on/off equivalence is the whole safety argument ──

describe('sweep — geometric pre-filter (§6)', () => {
  it('same program, same fixture, prefilter on vs off ⇒ byte-identical rows', () => {
    const allIds = OBJS.map((o) => o.noradId);
    const p = prog({
      pipeline: [
        { op: 'pick', ids: allIds },
        { op: 'sweep', predicate: elevGate(30, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    });
    const rowsOn = run(p, { disablePrefilter: false }).rows;
    const rowsOff = run(p, { disablePrefilter: true }).rows;
    assert.deepEqual(rowsOn, rowsOff);
  });

  it('the discriminator objects prove the filter does real (and correct) work, not a vacuous match', () => {
    const p = prog({
      pipeline: [
        { op: 'pick', ids: [100009, 100010, 100011] },
        { op: 'sweep', predicate: elevGate(30, 0), horizonMinutes: 60, stepSeconds: 60 },
      ],
    });
    const r = run(p);
    const byId = new Set((r.rows ?? []).map((row) => row.noradId));
    assert.ok(byId.has(100009), 'APOGEE_DISCRIMINATOR must be found — using apogee (not perigee) keeps it visible');
    assert.ok(!byId.has(100010), 'GEOMETRICALLY_EXCLUDED truly has no pass from latDeg 30');
    assert.ok(byId.has(100011), 'null inclination/apogeeKm must fail SAFE (never skip)');
  });
});

// ── Validator rules (V-SWEEP / V-TYPE) ──────────────────────────────────────────

function bad(p: unknown, code: ValidationCode): void {
  const r = validateProgram(p, { nowMs: NOW });
  assert.equal(r.ok, false, 'expected validation to fail');
  if (!r.ok) assert.ok(r.issues.some((i) => i.code === code), `expected ${code}, got ${JSON.stringify(r.issues)}`);
}

function ok(p: unknown): void {
  const r = validateProgram(p, { nowMs: NOW });
  assert.equal(r.ok, true, r.ok ? '' : `unexpected issues: ${JSON.stringify(r.issues)}`);
}

describe('sweep — validator rules', () => {
  it('V-SWEEP: sweep must be the final stage', () => bad(prog({
    pipeline: [
      { op: 'pick', ids: [100001] },
      { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
      { op: 'sort', by: 'name', dir: 'asc' },
    ],
  }), 'V-SWEEP'));

  it('V-SWEEP: sweep does not apply to a grouped relation', () => bad(prog({
    pipeline: [
      { op: 'groupBy', key: 'regime', aggs: { n: { fn: 'count' } } },
      { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
    ],
  }), 'V-SWEEP'));

  it("V-SWEEP: sweep needs universe 'live'", () => bad(prog({
    universe: 'all',
    pipeline: [
      { op: 'pick', ids: [100001] },
      { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 },
    ],
  }), 'V-SWEEP'));

  it('V-SWEEP: a bare whole-catalog sweep (no prior filter/pick/limit) is rejected', () => bad(prog({
    pipeline: [{ op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 }],
  }), 'V-SWEEP'));

  it('V-SWEEP: horizonMinutes over the cap', () => bad(prog({
    pipeline: [
      { op: 'pick', ids: [100001] },
      { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: SWEEP_MAX_HORIZON_MINUTES + 1, stepSeconds: 60 },
    ],
  }), 'V-SWEEP'));

  it('V-SWEEP: horizonMinutes non-positive', () => bad(prog({
    pipeline: [
      { op: 'pick', ids: [100001] },
      { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 0, stepSeconds: 60 },
    ],
  }), 'V-SWEEP'));

  it('V-SWEEP: stepSeconds under the floor', () => bad(prog({
    pipeline: [
      { op: 'pick', ids: [100001] },
      { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: SWEEP_MIN_STEP_SECONDS - 1 },
    ],
  }), 'V-SWEEP'));

  it('V-SWEEP: stepSeconds over the ceiling', () => bad(prog({
    pipeline: [
      { op: 'pick', ids: [100001] },
      { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: SWEEP_MAX_STEP_SECONDS + 1 },
    ],
  }), 'V-SWEEP'));

  it('V-TYPE: sweep.predicate must be bool', () => bad(prog({
    pipeline: [
      { op: 'pick', ids: [100001] },
      { op: 'sweep', predicate: { field: 'name' }, horizonMinutes: 60, stepSeconds: 60 },
    ],
  }), 'V-TYPE'));

  it('V-TYPE: sweep.peakOf must be number', () => bad(prog({
    pipeline: [
      { op: 'pick', ids: [100001] },
      { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60, peakOf: { field: 'name' } },
    ],
  }), 'V-TYPE'));

  // NOTE on coverage: the §2 rule "ceil(horizonMinutes*60/stepSeconds) must not
  // exceed SWEEP_MAX_OBJECT_STEPS on its own" is implemented (validate.ts) but is
  // UNREACHABLE with the landed caps — the worst case (horizonMinutes=10_080,
  // stepSeconds=5) is 120_960 steps, under the 500_000 cap — so no test can trigger
  // it without first tripping one of the two checks above. Kept as defense-in-depth
  // per the brief; see validate.ts's comment on that branch.

  it('sanity: pick, filter, and limit each independently satisfy the narrowing precondition', () => {
    ok(prog({ pipeline: [{ op: 'pick', ids: [100001] }, { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 }] }));
    ok(prog({ pipeline: [{ op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } }, { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 }] }));
    ok(prog({ pipeline: [{ op: 'limit', n: 5 }, { op: 'sweep', predicate: elevGate(0, 0), horizonMinutes: 60, stepSeconds: 60 }] }));
  });
});
