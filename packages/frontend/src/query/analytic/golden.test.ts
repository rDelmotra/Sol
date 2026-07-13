// ============================================================
// Analytic IR v1 — golden corpus (P0 paper-validation, now executable).
//
// Valid programs: hand-compilations of my_plans/marvin/perceptor_question_corpus.md
// questions (spec §10 + the rest of the v1-scope A–I classes) — every one
// must pass validation. Invalid programs: J-class refusals and cap/type
// violations — each must fail with the EXACT error code the repair loop
// keys on. Fixed clock (nowMs) keeps V-TIMECAP tests deterministic.
//
// Expected-VALUE assertions arrive with the executor; this file locks the
// language's expressiveness and the validator's contract first.
// ============================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateProgram, type ValidationCode } from './validate';

const NOW = Date.parse('2026-07-10T12:00:00Z');

function ok(p: unknown): void {
  const r = validateProgram(p, { nowMs: NOW });
  assert.equal(r.ok, true, r.ok ? '' : `unexpected issues: ${JSON.stringify(r.issues, null, 2)}`);
}

function bad(p: unknown, code: ValidationCode): void {
  const r = validateProgram(p, { nowMs: NOW });
  assert.equal(r.ok, false, `expected ${code} but program validated`);
  if (!r.ok) {
    assert.ok(
      r.issues.some((i) => i.code === code),
      `expected ${code}, got ${JSON.stringify(r.issues)}`,
    );
  }
}

/** Envelope factory — tests override what they exercise. */
function prog(over: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    universe: 'live',
    timeBinding: { mode: 'now' },
    interpretation: 'test interpretation',
    output: { shape: 'ids' },
    ...over,
  };
}

// ── A. Live instantaneous ─────────────────────────────────────────────────────

describe('golden corpus — A. live instantaneous', () => {
  it('A1: how fast is the ISS moving right now?', () => ok(prog({
    pipeline: [{ op: 'pick', ids: [25544] }],
    output: { shape: 'object', columns: ['name', 'speedKmS', 'altitudeKm'] },
  })));

  it('A2: how many objects are in Earth’s shadow right now?', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { field: 'eclipsed' } },
      { op: 'aggregate', aggs: { n: { fn: 'count' } } },
    ],
    output: { shape: 'scalar' },
  })));

  it('A3: what is directly above me?', () => ok(prog({
    pipeline: [
      { op: 'derive', fields: { elev: { fn: 'elevationDeg', observer: 'user' } } },
      { op: 'filter', where: { op: '>', args: [{ field: 'elev' }, { lit: 85 }] } },
      { op: 'sort', by: 'elev', dir: 'desc' },
      { op: 'limit', n: 5 },
    ],
    output: { shape: 'table', columns: ['name', 'elev', 'altitudeKm'] },
  })));

  it('A5: closest object to the ISS right now', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: '!=', args: [{ field: 'noradId' }, { lit: 25544 }] } },
      { op: 'derive', fields: { d: { fn: 'distToKm', target: 25544 } } },
      { op: 'sort', by: 'd', dir: 'asc' },
      { op: 'limit', n: 1 },
    ],
    output: { shape: 'object', columns: ['name', 'd'] },
  })));

  it('A6: how many Starlink satellites are above my horizon?', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'and', args: [
        { op: 'in', field: 'program', values: ['starlink'] },
        { op: '>', args: [{ fn: 'elevationDeg', observer: 'user' }, { lit: 0 }] },
      ] } },
      { op: 'aggregate', aggs: { n: { fn: 'count' } } },
    ],
    output: { shape: 'scalar' },
  })));

  it('A7: what fraction of the catalog is south of the equator?', () => ok(prog({
    pipeline: [
      { op: 'aggregate', aggs: { south: { fn: 'share', where: { op: '<', args: [{ field: 'latDeg' }, { lit: 0 }] } } } },
    ],
    output: { shape: 'scalar' },
  })));

  it('A8: GEO satellites over longitude 0°', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'and', args: [
        { op: 'in', field: 'regime', values: ['GEO'] },
        { op: '<', args: [{ op: 'abs', arg: { field: 'lonDeg' } }, { lit: 1 }] },
      ] } },
    ],
  })));
});

// ── B. Derivatives (live fast-path only in v1) ────────────────────────────────

describe('golden corpus — B. derivatives', () => {
  it('B1: which satellites are slowing down? (meanMotionDot fast-path)', () => ok(prog({
    interpretation: 'orbit decaying = mean motion increasing (decaying orbits actually gain speed)',
    pipeline: [
      { op: 'filter', where: { op: '>', args: [{ field: 'meanMotionDot' }, { lit: 0 }] } },
      { op: 'sort', by: 'meanMotionDot', dir: 'desc' },
    ],
  })));

  it('B-class history fields are a NAMED GAP in v1 (decayDate → V-FIELD)', () => bad(prog({
    pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'decayDate' }, { lit: '2020-01-01' }] } }],
  }), 'V-FIELD'));
});

// ── C. Physics & observer ─────────────────────────────────────────────────────

describe('golden corpus — C. physics & observer', () => {
  it('C1: naked-eye visible from my location right now', () => ok(prog({
    pipeline: [{ op: 'filter', where: { fn: 'visuallyVisible', observer: 'user' } }],
  })));

  it('C2: in sunlight while I am in darkness', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'and', args: [
        { op: 'not', arg: { field: 'eclipsed' } },
        { fn: 'observerDark', observer: 'user' },
      ] } },
    ],
  })));

  it('C3: what fraction of Starlink is eclipsed?', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'in', field: 'program', values: ['starlink'] } },
      { op: 'aggregate', aggs: { frac: { fn: 'share', where: { field: 'eclipsed' } } } },
    ],
    output: { shape: 'scalar' },
  })));

  it('C4: how long until the ISS exits Earth’s shadow?', () => ok(prog({
    pipeline: [
      { op: 'pick', ids: [25544] },
      { op: 'timeScan', predicate: { op: 'not', arg: { field: 'eclipsed' } }, direction: 'forward', stepMinutes: 1, maxSteps: 120 },
    ],
    output: { shape: 'scalar' },
  })));

  it('C6: where will the ISS be at 21:00 tonight? (timeBinding at)', () => ok(prog({
    timeBinding: { mode: 'at', t: '2026-07-10T21:00:00Z' },
    pipeline: [{ op: 'pick', ids: [25544] }],
    output: { shape: 'object', columns: ['name', 'latDeg', 'lonDeg', 'altitudeKm'] },
  })));
});

// ── D. Entity graph ───────────────────────────────────────────────────────────

describe('golden corpus — D. entity graph', () => {
  it('D2: which rocket family put the most objects up?', () => ok(prog({
    pipeline: [
      { op: 'groupBy', key: 'launch.lvFamily', aggs: { n: { fn: 'count' } } },
      { op: 'sort', by: 'n', dir: 'desc' },
      { op: 'limit', n: 10 },
    ],
    output: { shape: 'grouped' },
  })));

  it('D4: SpaceX vs Amazon fleet counts', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'in', field: 'ownerFamily', values: ['SPX', 'AMZN'] } },
      { op: 'groupBy', key: 'ownerFamily', aggs: { n: { fn: 'count' } } },
    ],
    output: { shape: 'grouped' },
  })));

  it('D5: whose debris dominates LEO?', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'and', args: [
        { op: 'in', field: 'objectType', values: ['debris'] },
        { op: 'in', field: 'regime', values: ['LEO'] },
      ] } },
      { op: 'groupBy', key: 'countryCode', aggs: { n: { fn: 'count' } } },
      { op: 'sort', by: 'n', dir: 'desc' },
      { op: 'limit', n: 10 },
    ],
    output: { shape: 'grouped' },
  })));

  it('D7: which launch sites produced the most still-orbiting debris?', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'in', field: 'objectType', values: ['debris'] } },
      { op: 'groupBy', key: 'launch.siteName', aggs: { n: { fn: 'count' } } },
      { op: 'sort', by: 'n', dir: 'desc' },
      { op: 'limit', n: 10 },
    ],
    output: { shape: 'grouped' },
  })));

  it('D8: what debris came from Kosmos-1408? (separation tree)', () => ok(prog({
    pipeline: [{ op: 'filter', where: { fn: 'descendsFrom', ancestor: 13552 } }],
  })));
});

// ── E. Aggregation & distribution ─────────────────────────────────────────────

describe('golden corpus — E. aggregation', () => {
  it('E1: total mass currently in orbit (coverage-caveat demo)', () => ok(prog({
    interpretation: 'sum of known launch-stack masses; executor reports the coverage basis',
    pipeline: [{ op: 'aggregate', aggs: { kg: { fn: 'sum', of: 'totMassKg' } } }],
    output: { shape: 'scalar' },
  })));

  it('E4: median age of LEO debris', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'and', args: [
        { op: 'in', field: 'objectType', values: ['debris'] },
        { op: 'in', field: 'regime', values: ['LEO'] },
      ] } },
      { op: 'aggregate', aggs: { med: { fn: 'median', of: 'ageYears' } } },
    ],
    output: { shape: 'scalar' },
  })));

  it('E5: most crowded 100 km altitude band', () => ok(prog({
    pipeline: [
      { op: 'derive', fields: { band: { op: 'bucket', arg: { field: 'meanAltitudeKm' }, width: 100 } } },
      { op: 'groupBy', key: 'band', aggs: { n: { fn: 'count' } } },
      { op: 'sort', by: 'n', dir: 'desc' },
      { op: 'limit', n: 1 },
    ],
    output: { shape: 'grouped' },
  })));

  it('E6: share of payloads that are commercial (multi-valued has)', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'in', field: 'objectType', values: ['payload'] } },
      { op: 'aggregate', aggs: { s: { fn: 'share', where: { op: 'has', field: 'sectors', value: 'commercial' } } } },
    ],
    output: { shape: 'scalar' },
  })));
});

// ── F. Superlatives ───────────────────────────────────────────────────────────

describe('golden corpus — F. superlatives', () => {
  it('F1: oldest object still in orbit (Vanguard 1 anchor)', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'in', field: 'status', values: ['in_orbit'] } },
      { op: 'sort', by: 'launchDate', dir: 'asc' },
      { op: 'limit', n: 1 },
    ],
    output: { shape: 'object', columns: ['name', 'launchDate', 'ageYears'] },
  })));

  it('F3: most eccentric orbits', () => ok(prog({
    pipeline: [
      { op: 'sort', by: 'eccentricity', dir: 'desc' },
      { op: 'limit', n: 10 },
    ],
    output: { shape: 'table', columns: ['name', 'eccentricity'] },
  })));

  it('F4: fastest object right now', () => ok(prog({
    pipeline: [
      { op: 'sort', by: 'speedKmS', dir: 'desc' },
      { op: 'limit', n: 1 },
    ],
    output: { shape: 'object', columns: ['name', 'speedKmS', 'perigeeKm'] },
  })));

  it('F6: highest apogee ever cataloged (universe selector)', () => ok(prog({
    universe: 'all',
    interpretation: `'ever' = full historical catalog incl. decayed`,
    pipeline: [
      { op: 'sort', by: 'apogeeKm', dir: 'desc' },
      { op: 'limit', n: 1 },
    ],
    output: { shape: 'object', columns: ['name', 'apogeeKm', 'status'] },
  })));
});

// ── G. Comparison ─────────────────────────────────────────────────────────────

describe('golden corpus — G. comparison', () => {
  it('G2: ISS vs average LEO altitude (compare pipeline)', () => ok(prog({
    pipeline: [{ op: 'pick', ids: [25544] }],
    compare: {
      label: 'LEO average',
      pipeline: [
        { op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } },
        { op: 'aggregate', aggs: { avgAlt: { fn: 'avg', of: 'meanAltitudeKm' } } },
      ],
    },
    output: { shape: 'object', columns: ['name', 'meanAltitudeKm'] },
  })));

  it('G3: China vs US LEO counts by launch year (multi-key groupBy)', () => ok(prog({
    pipeline: [
      { op: 'filter', where: { op: 'and', args: [
        { op: 'in', field: 'regime', values: ['LEO'] },
        { op: 'in', field: 'countryCode', values: ['PRC', 'US'] },
      ] } },
      { op: 'groupBy', key: ['countryCode', 'launchYear'], aggs: { n: { fn: 'count' } } },
      { op: 'sort', by: 'n', dir: 'desc' },
    ],
    output: { shape: 'grouped' },
  })));
});

// ── I. Ambiguity probes (interpretation contract) ─────────────────────────────

describe('golden corpus — I. ambiguity probes', () => {
  it('I2: biggest satellite = heaviest, with alternatives stated', () => ok(prog({
    interpretation: `'biggest' read as heaviest (totMassKg); alternatives: longest (lengthM), largest span (spanM)`,
    pipeline: [
      { op: 'filter', where: { op: 'in', field: 'objectType', values: ['payload'] } },
      { op: 'sort', by: 'totMassKg', dir: 'desc' },
      { op: 'limit', n: 1 },
    ],
    output: { shape: 'object', columns: ['name', 'totMassKg', 'lengthM', 'spanM'] },
  })));

  it('I1: "falling" = fastest-decaying, via B1 machinery', () => ok(prog({
    interpretation: 'every orbit is falling; read as decaying fastest (meanMotionDot), alternative: reentering soon (lowest perigee)',
    pipeline: [
      { op: 'sort', by: 'meanMotionDot', dir: 'desc' },
      { op: 'limit', n: 20 },
    ],
    output: { shape: 'table', columns: ['name', 'meanMotionDot', 'perigeeKm'] },
  })));
});

// ── Validator contract: every code fires on the program that earns it ─────────

describe('validator contract — typed refusals', () => {
  it('V-GROUP: groupBy on a multi-valued facet', () => bad(prog({
    pipeline: [{ op: 'groupBy', key: 'sectors', aggs: { n: { fn: 'count' } } }],
    output: { shape: 'grouped' },
  }), 'V-GROUP'));

  it('V-PLANE: live field under universe all', () => bad(prog({
    universe: 'all',
    pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'speedKmS' }, { lit: 7 }] } }],
  }), 'V-PLANE'));

  it('V-PLANE: live fn under universe all', () => bad(prog({
    universe: 'all',
    pipeline: [{ op: 'filter', where: { op: '>', args: [{ fn: 'elevationDeg', observer: 'user' }, { lit: 10 }] } }],
  }), 'V-PLANE'));

  it('V-ENUM: value outside the regime domain', () => bad(prog({
    pipeline: [{ op: 'filter', where: { op: 'in', field: 'regime', values: ['XEO'] } }],
  }), 'V-ENUM'));

  it('V-ENUM: equality against a value outside an enum domain', () => bad(prog({
    pipeline: [{ op: 'filter', where: { op: '==', args: [{ field: 'purpose' }, { lit: 'spying' }] } }],
  }), 'V-ENUM'));

  it('V-FIELD: unknown field', () => bad(prog({
    pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'warpFactor' }, { lit: 9 }] } }],
  }), 'V-FIELD'));

  it('V-FIELD: derive shadowing a base field', () => bad(prog({
    pipeline: [{ op: 'derive', fields: { name: { lit: 1 } } }],
  }), 'V-FIELD'));

  it('V-PIPE: more than 8 stages', () => bad(prog({
    pipeline: Array.from({ length: 9 }, () => ({ op: 'filter', where: { field: 'eclipsed' } })),
  }), 'V-PIPE'));

  it('V-PIPE: aggregate not final', () => bad(prog({
    pipeline: [
      { op: 'aggregate', aggs: { n: { fn: 'count' } } },
      { op: 'sort', by: 'n', dir: 'desc' },
    ],
    output: { shape: 'scalar' },
  }), 'V-PIPE'));

  it('V-EXPR: expression deeper than 6', () => {
    let e: Record<string, unknown> = { field: 'meanMotion' };
    for (let i = 0; i < 7; i++) e = { op: 'abs', arg: e };
    bad(prog({
      pipeline: [{ op: 'filter', where: { op: '>', args: [e, { lit: 0 }] } }],
    }), 'V-EXPR');
  });

  it('V-EXPR: and with a single arg', () => bad(prog({
    pipeline: [{ op: 'filter', where: { op: 'and', args: [{ field: 'eclipsed' }] } }],
  }), 'V-EXPR'));

  it('V-TYPE: arithmetic on a string field', () => bad(prog({
    pipeline: [{ op: 'derive', fields: { x: { op: '+', args: [{ field: 'name' }, { lit: 1 }] } } }],
  }), 'V-TYPE'));

  it('V-TYPE: has on a single-valued enum', () => bad(prog({
    pipeline: [{ op: 'filter', where: { op: 'has', field: 'purpose', value: 'communications' } }],
  }), 'V-TYPE'));

  it('V-SCAN: timeScan without narrowing to ≤ 5 objects', () => bad(prog({
    pipeline: [
      { op: 'timeScan', predicate: { field: 'eclipsed' }, direction: 'forward', stepMinutes: 1, maxSteps: 60 },
    ],
    output: { shape: 'scalar' },
  }), 'V-SCAN'));

  it('V-SCAN: timeScan over the step cap', () => bad(prog({
    pipeline: [
      { op: 'pick', ids: [25544] },
      { op: 'timeScan', predicate: { field: 'eclipsed' }, direction: 'forward', stepMinutes: 1, maxSteps: 500 },
    ],
    output: { shape: 'scalar' },
  }), 'V-SCAN'));

  it('V-TIMECAP: timeBinding beyond the +14 d future horizon', () => bad(prog({
    timeBinding: { mode: 'at', t: '2026-08-20T00:00:00Z' },
    pipeline: [{ op: 'pick', ids: [25544] }],
    output: { shape: 'object', columns: ['name'] },
  }), 'V-TIMECAP'));

  it('V-INTERP: missing interpretation', () => bad(prog({
    interpretation: '',
    pipeline: [{ op: 'filter', where: { field: 'eclipsed' } }],
  }), 'V-INTERP'));

  it('V-LIMIT: limit over 1000', () => bad(prog({
    pipeline: [{ op: 'limit', n: 5000 }],
  }), 'V-LIMIT'));

  it('V-LIMIT: table output without a limit stage', () => bad(prog({
    pipeline: [{ op: 'filter', where: { field: 'eclipsed' } }],
    output: { shape: 'table', columns: ['name'] },
  }), 'V-LIMIT'));

  it('V-OUTPUT: grouped output without a groupBy', () => bad(prog({
    pipeline: [{ op: 'filter', where: { field: 'eclipsed' } }],
    output: { shape: 'grouped' },
  }), 'V-OUTPUT'));

  it('V-OUTPUT: object output without narrowing to one row', () => bad(prog({
    pipeline: [{ op: 'filter', where: { field: 'eclipsed' } }],
    output: { shape: 'object', columns: ['name'] },
  }), 'V-OUTPUT'));

  it('V-SHAPE: non-object program', () => bad(42, 'V-SHAPE'));

  it('V-SHAPE: unknown stage op', () => bad(prog({
    pipeline: [{ op: 'teleport', where: { field: 'eclipsed' } }],
  }), 'V-SHAPE'));
});
