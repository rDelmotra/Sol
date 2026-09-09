// ============================================================
// Analytic IR v1 — executor value tests.
//
// A 12-object fixture catalog with hand-computed answers upgrades the golden
// corpus from "the language can express it" (golden.test.ts) to "the answer
// is right". The fixture implements AnalyticDataSource directly — the same
// port the real live adapter (worker buffers + orbital/ + entity maps) will
// implement.
//
// Fixture invariants the assertions depend on are listed next to the data.
// ============================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateProgram } from './validate.js';
import { execute, type AnalyticDataSource, type FieldValue, type ExecuteOutcome } from './execute.js';
import type { AnalyticResult } from './types.js';

const NOW = Date.parse('2026-07-10T12:00:00Z');
const OBSERVER = { latDeg: 51.5, lonDeg: 0 };

// ── Fixture ───────────────────────────────────────────────────────────────────

interface Fixture {
  noradId: number;
  fields: Record<string, FieldValue>;
  elev?: number | null;
  distToIss?: number | null;
  parentNorad?: number;
  /** eclipsed = (t − NOW) < this many minutes; absent → fields.eclipsed static. */
  eclipsedUntilMin?: number;
}

function obj(
  noradId: number,
  fields: Record<string, FieldValue>,
  extra?: Omit<Fixture, 'noradId' | 'fields'>,
): Fixture {
  return { noradId, fields, ...extra };
}

// LIVE universe (10 objects). Hand-computed expectations:
//   eclipsed now: 44713 (until +12 min), 45044 (always), 49863 (static)  → count 3
//   meanMotionDot > 0 desc: 49863 (.005), 49864 (.003), 25544 (.0002), 44713 (.00001)
//   totMassKg: 6 present of 10; sum = 420000+260+260+3000+1.5+11110 = 434631.5
//   LEO meanAltitudeKm avg: (420+550+550+550+485+480+470+615)/8 = 515
//   100 km bands: 400 → {ISS, 13552, 49863, 49864} = 4;  500 → {1007, 1008, 2000} = 3
//   lvFamily counts: Falcon 9 = 3, Tsyklon = 2 (49863's launch row is missing)
//   latDeg < 0: ISS, 49863, 49864, HST → share 0.4
const LIVE: Fixture[] = [
  obj(25544, {
    name: 'ISS (ZARYA)', countryCode: 'US', regime: 'LEO', objectType: 'payload', status: 'in_orbit',
    meanMotionDot: 0.0002, totMassKg: 420000, launchDate: '1998-11-20', launchYear: 1998, ageYears: 27.6,
    'launch.lvFamily': 'Proton', 'launch.siteName': 'Baikonur', sectors: ['government', 'civil'],
    speedKmS: 7.66, altitudeKm: 420, latDeg: -10, lonDeg: 100, eclipsed: false,
    apogeeKm: 424, perigeeKm: 416, eccentricity: 0.0005, meanAltitudeKm: 420,
  }, { elev: 45, distToIss: 0 }),
  obj(44713, {
    name: 'STARLINK-1007', program: 'starlink', ownerFamily: 'SPX', countryCode: 'US', regime: 'LEO',
    objectType: 'payload', status: 'in_orbit', meanMotionDot: 0.00001, totMassKg: 260,
    launchDate: '2019-11-11', launchYear: 2019, ageYears: 6.7, 'launch.lvFamily': 'Falcon 9',
    'launch.siteName': 'Canaveral', sectors: ['commercial'], speedKmS: 7.6, altitudeKm: 550,
    latDeg: 30, lonDeg: -60, apogeeKm: 560, perigeeKm: 540, eccentricity: 0.0001, meanAltitudeKm: 550,
  }, { elev: -10, distToIss: 500, eclipsedUntilMin: 12 }),
  obj(44714, {
    name: 'STARLINK-1008', program: 'starlink', ownerFamily: 'SPX', countryCode: 'US', regime: 'LEO',
    objectType: 'payload', status: 'in_orbit', meanMotionDot: -0.00001, totMassKg: 260,
    launchDate: '2019-11-11', launchYear: 2019, ageYears: 6.7, 'launch.lvFamily': 'Falcon 9',
    'launch.siteName': 'Canaveral', sectors: ['commercial'], speedKmS: 7.6, altitudeKm: 550,
    latDeg: 40, lonDeg: -65, eclipsed: false, meanAltitudeKm: 550, eccentricity: 0.0001,
  }, { elev: 30, distToIss: 1200 }),
  obj(45044, {
    name: 'STARLINK-2000', program: 'starlink', ownerFamily: 'SPX', countryCode: 'US', regime: 'LEO',
    objectType: 'payload', status: 'in_orbit', meanMotionDot: 0, totMassKg: null,
    launchDate: '2020-02-17', launchYear: 2020, ageYears: 6.4, 'launch.lvFamily': 'Falcon 9',
    'launch.siteName': 'Canaveral', sectors: ['commercial'], speedKmS: 7.6, altitudeKm: 550,
    latDeg: 10, lonDeg: 20, meanAltitudeKm: 550, eccentricity: 0.0002,
  }, { elev: 5, distToIss: 2000, eclipsedUntilMin: Infinity }),
  obj(13552, {
    name: 'KOSMOS-1408', countryCode: 'CIS', regime: 'LEO', objectType: 'payload', status: 'in_orbit',
    meanMotionDot: 0, totMassKg: null, launchDate: '1982-09-16', launchYear: 1982, ageYears: 43.8,
    'launch.lvFamily': 'Tsyklon', 'launch.siteName': 'Plesetsk', sectors: ['military'],
    speedKmS: 7.55, altitudeKm: 485, latDeg: 60, lonDeg: 30, eclipsed: false,
    meanAltitudeKm: 485, eccentricity: 0.002,
  }, { elev: -50, distToIss: 900 }),
  obj(49863, {
    name: 'KOSMOS-1408 DEB', countryCode: 'CIS', regime: 'LEO', objectType: 'debris', status: 'in_orbit',
    meanMotionDot: 0.005, totMassKg: null, launchDate: '1982-09-16', launchYear: 1982, ageYears: 43.8,
    'launch.lvFamily': null, sectors: [], speedKmS: 7.58, altitudeKm: 480,
    latDeg: -30, lonDeg: 140, eclipsed: true, meanAltitudeKm: 480, eccentricity: 0.004,
  }, { elev: 0, distToIss: 880, parentNorad: 13552 }),
  obj(49864, {
    name: 'KOSMOS-1408 DEB', countryCode: 'CIS', regime: 'LEO', objectType: 'debris', status: 'in_orbit',
    meanMotionDot: 0.003, totMassKg: null, launchDate: '1982-09-16', launchYear: 1982, ageYears: 43.8,
    'launch.lvFamily': 'Tsyklon', sectors: [], speedKmS: 7.57, altitudeKm: 470,
    latDeg: -40, lonDeg: 150, eclipsed: false, meanAltitudeKm: 470, eccentricity: 0.003,
  }, { elev: -5, distToIss: 950, parentNorad: 13552 }),
  obj(22049, {
    name: 'GALAXY-7', countryCode: 'US', regime: 'GEO', objectType: 'payload', status: 'in_orbit',
    meanMotionDot: 0, totMassKg: 3000, launchDate: '1992-10-28', launchYear: 1992, ageYears: 33.7,
    'launch.lvFamily': 'Ariane', 'launch.siteName': 'Kourou', sectors: ['commercial'],
    speedKmS: 3.07, altitudeKm: 35786, latDeg: 0, lonDeg: 0.5, eclipsed: false,
    apogeeKm: 35800, perigeeKm: 35772, eccentricity: 0.0001, meanAltitudeKm: 35786,
  }, { elev: 10, distToIss: 35500 }),
  obj(5, {
    name: 'VANGUARD 1', countryCode: 'US', regime: 'OTHER', objectType: 'payload', status: 'in_orbit',
    meanMotionDot: 0, totMassKg: 1.5, launchDate: '1958-03-17', launchYear: 1958, ageYears: 68.3,
    'launch.lvFamily': 'Vanguard', 'launch.siteName': 'Canaveral', sectors: [],
    speedKmS: 5.5, altitudeKm: 1200, latDeg: 20, lonDeg: -30, eclipsed: false,
    apogeeKm: 3800, perigeeKm: 650, eccentricity: 0.19, meanAltitudeKm: 2225,
  }, { elev: 88, distToIss: 3200 }),
  obj(20580, {
    name: 'HST', countryCode: 'US', regime: 'LEO', objectType: 'payload', status: 'in_orbit',
    meanMotionDot: 0, totMassKg: 11110, launchDate: '1990-04-24', launchYear: 1990, ageYears: 36.2,
    'launch.lvFamily': 'Shuttle', 'launch.siteName': 'Canaveral', sectors: ['government', 'civil'],
    speedKmS: 7.59, altitudeKm: 615, latDeg: -20, lonDeg: 80, eclipsed: false,
    meanAltitudeKm: 615, eccentricity: 0.0003,
  }, { elev: 10, distToIss: 230 }),
];

// ALL universe = LIVE + 2 decayed objects (no live-plane values).
const ALL: Fixture[] = [
  ...LIVE,
  obj(12345, {
    name: 'OLD ROCKET', countryCode: 'CIS', objectType: 'rocket_body', status: 'decayed',
    totMassKg: 8000, launchDate: '1975-05-01', launchYear: 1975, apogeeKm: 40000, eccentricity: 0.7,
  }),
  obj(6543, {
    name: 'DEAD SAT', countryCode: 'US', objectType: 'payload', status: 'decayed',
    totMassKg: 5000, launchDate: '1970-01-15', launchYear: 1970, apogeeKm: 800, eccentricity: 0.001,
  }),
];

function makeSource(objs: Fixture[]): AnalyticDataSource {
  const byNorad = new Map(objs.map((o, i) => [o.noradId, i]));
  return {
    size: () => objs.length,
    noradId: (i) => objs[i].noradId,
    noradToIndex: (id) => byNorad.get(id),
    getField: (i, field, tMs) => {
      const o = objs[i];
      if (field === 'noradId') return o.noradId;
      if (field === 'eclipsed' && o.eclipsedUntilMin !== undefined) {
        return (tMs - NOW) / 60_000 < o.eclipsedUntilMin;
      }
      return o.fields[field] ?? null;
    },
    elevationDeg: (i) => LIVE_ELEV(objs[i]),
    rangeKm: () => null,
    observerDark: () => true,
    visuallyVisible: (i) => LIVE_ELEV(objs[i]) !== null ? (LIVE_ELEV(objs[i]) as number) > 10 : null,
    distToKm: (i, target) => (target === 25544 ? objs[i].distToIss ?? null : null),
    descendsFrom: (i, ancestor) => objs[i].parentNorad === ancestor,
  };
}

function LIVE_ELEV(o: Fixture): number | null {
  return o.elev ?? null;
}

const SOURCES = { live: makeSource(LIVE), all: makeSource(ALL) };

// ── Harness ───────────────────────────────────────────────────────────────────

function run(p: Record<string, unknown>, opts?: { observer?: typeof OBSERVER | null }): AnalyticResult {
  const v = validateProgram(p, { nowMs: NOW });
  assert.equal(v.ok, true, v.ok ? '' : `program invalid: ${JSON.stringify(v.issues)}`);
  if (!v.ok) throw new Error('unreachable');
  const out = execute(v.program, SOURCES, { nowMs: NOW, observer: opts?.observer ?? OBSERVER });
  assert.equal(out.ok, true, out.ok ? '' : `runtime error: ${JSON.stringify(out.error)}`);
  if (!out.ok) throw new Error('unreachable');
  return out.result;
}

function runRaw(p: Record<string, unknown>, opts?: { observer?: typeof OBSERVER | null; noAll?: boolean }): ExecuteOutcome {
  const v = validateProgram(p, { nowMs: NOW });
  assert.equal(v.ok, true);
  if (!v.ok) throw new Error('unreachable');
  const sources = opts?.noAll ? { live: SOURCES.live } : SOURCES;
  return execute(v.program, sources, { nowMs: NOW, observer: opts?.observer === undefined ? OBSERVER : opts.observer });
}

function prog(over: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1, universe: 'live', timeBinding: { mode: 'now' },
    interpretation: 'test', output: { shape: 'ids' }, ...over,
  };
}

// ── Value tests ───────────────────────────────────────────────────────────────

describe('executor — corpus answers over the fixture', () => {
  it('A1: ISS speed and altitude', () => {
    const r = run(prog({
      pipeline: [{ op: 'pick', ids: [25544] }],
      output: { shape: 'object', columns: ['name', 'speedKmS', 'altitudeKm'] },
    }));
    assert.deepEqual(r.rows, [{ noradId: 25544, name: 'ISS (ZARYA)', speedKmS: 7.66, altitudeKm: 420 }]);
  });

  it('A2: eclipse count is 3', () => {
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { field: 'eclipsed' } },
        { op: 'aggregate', aggs: { n: { fn: 'count' } } },
      ],
      output: { shape: 'scalar' },
    }));
    assert.equal(r.value, 3);
  });

  it('A3: zenith object is Vanguard 1', () => {
    const r = run(prog({
      pipeline: [
        { op: 'derive', fields: { elev: { fn: 'elevationDeg', observer: 'user' } } },
        { op: 'filter', where: { op: '>', args: [{ field: 'elev' }, { lit: 85 }] } },
        { op: 'sort', by: 'elev', dir: 'desc' },
        { op: 'limit', n: 5 },
      ],
      output: { shape: 'table', columns: ['name', 'elev'] },
    }));
    assert.deepEqual(r.rows, [{ noradId: 5, name: 'VANGUARD 1', elev: 88 }]);
  });

  it('A5: closest object to the ISS is HST at 230 km', () => {
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { op: '!=', args: [{ field: 'noradId' }, { lit: 25544 }] } },
        { op: 'derive', fields: { d: { fn: 'distToKm', target: 25544 } } },
        { op: 'sort', by: 'd', dir: 'asc' },
        { op: 'limit', n: 1 },
      ],
      output: { shape: 'object', columns: ['name', 'd'] },
    }));
    assert.deepEqual(r.rows, [{ noradId: 20580, name: 'HST', d: 230 }]);
  });

  it('A7: share south of the equator is 0.4', () => {
    const r = run(prog({
      pipeline: [
        { op: 'aggregate', aggs: { south: { fn: 'share', where: { op: '<', args: [{ field: 'latDeg' }, { lit: 0 }] } } } },
      ],
      output: { shape: 'scalar' },
    }));
    assert.equal(r.value, 0.4);
  });

  it('B1: decaying objects, fastest first', () => {
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { op: '>', args: [{ field: 'meanMotionDot' }, { lit: 0 }] } },
        { op: 'sort', by: 'meanMotionDot', dir: 'desc' },
      ],
    }));
    assert.deepEqual(Array.from(r.ids ?? []), [49863, 49864, 25544, 44713]);
    assert.equal(r.meta.matched, 4);
    assert.equal(r.meta.scanned, 10);
  });

  it('C3: two thirds of Starlink is eclipsed', () => {
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { op: 'in', field: 'program', values: ['starlink'] } },
        { op: 'aggregate', aggs: { frac: { fn: 'share', where: { field: 'eclipsed' } } } },
      ],
      output: { shape: 'scalar' },
    }));
    assert.equal(r.value, 2 / 3);
  });

  it('C4: STARLINK-1007 exits shadow in 12 minutes (timeScan)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [44713] },
        { op: 'timeScan', predicate: { op: 'not', arg: { field: 'eclipsed' } }, direction: 'forward', stepMinutes: 1, maxSteps: 120 },
      ],
      output: { shape: 'scalar' },
    }));
    assert.equal(r.value, 12);
  });

  it('C4b: a never-flipping timeScan clips honestly', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [45044] },
        { op: 'timeScan', predicate: { op: 'not', arg: { field: 'eclipsed' } }, direction: 'forward', stepMinutes: 1, maxSteps: 20 },
      ],
      output: { shape: 'scalar' },
    }));
    assert.equal(r.value, undefined);
    assert.equal(r.meta.clipped?.length, 1);
  });

  // sweep (P3): this fixture's elevationDeg is STATIC (ignores tMs — see LIVE_ELEV),
  // so a sweep against it degenerates to "above threshold the whole horizon, or
  // never" — a real but minimal integration check against the SAME shared fixture
  // and AnalyticDataSource port every other corpus test uses. Interval-shape/edge/
  // peak precision is covered exhaustively in sweep.test.ts's own time-varying fixture.
  it('C5: sweep over the shared fixture — VANGUARD 1 (elev 88) full-horizon pass, STARLINK-1007 (elev -10) none', () => {
    const r = run(prog({
      pipeline: [
        { op: 'pick', ids: [44713, 5] },
        {
          op: 'sweep',
          predicate: { op: '>', args: [{ fn: 'elevationDeg', observer: 'user' }, { lit: 10 }] },
          horizonMinutes: 30,
          stepSeconds: 60,
        },
      ],
      output: { shape: 'grouped' },
    }));
    assert.deepEqual(r.rows, [{
      noradId: 5,
      name: 'VANGUARD 1',
      startIso: new Date(NOW).toISOString(),
      endIso: new Date(NOW + 30 * 60_000).toISOString(),
      durationMinutes: 30,
      clippedEdge: 'both',
    }]);
  });

  it('D2: launch families — Falcon 9 (3) then Tsyklon (2)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'groupBy', key: 'launch.lvFamily', aggs: { n: { fn: 'count' } } },
        { op: 'sort', by: 'n', dir: 'desc' },
        { op: 'limit', n: 2 },
      ],
      output: { shape: 'grouped' },
    }));
    assert.deepEqual(r.rows, [
      { 'launch.lvFamily': 'Falcon 9', n: 3 },
      { 'launch.lvFamily': 'Tsyklon', n: 2 },
    ]);
  });

  it('D8: the Kosmos-1408 debris cloud via the separation tree', () => {
    const r = run(prog({
      pipeline: [{ op: 'filter', where: { fn: 'descendsFrom', ancestor: 13552 } }],
    }));
    assert.deepEqual(Array.from(r.ids ?? []), [49863, 49864]);
  });

  it('E1: total mass with an honest coverage basis', () => {
    const r = run(prog({
      pipeline: [{ op: 'aggregate', aggs: { kg: { fn: 'sum', of: 'totMassKg' } } }],
      output: { shape: 'scalar' },
    }));
    assert.equal(r.value, 434631.5);
    assert.deepEqual(r.meta.coverage, [{ field: 'totMassKg', present: 6, total: 10 }]);
  });

  it('E4: median age of LEO debris', () => {
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { op: 'and', args: [
          { op: 'in', field: 'objectType', values: ['debris'] },
          { op: 'in', field: 'regime', values: ['LEO'] },
        ] } },
        { op: 'aggregate', aggs: { med: { fn: 'median', of: 'ageYears' } } },
      ],
      output: { shape: 'scalar' },
    }));
    assert.equal(r.value, 43.8);
  });

  it('E5: the 400 km band is the most crowded (bucket + groupBy)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'derive', fields: { band: { op: 'bucket', arg: { field: 'meanAltitudeKm' }, width: 100 } } },
        { op: 'groupBy', key: 'band', aggs: { n: { fn: 'count' } } },
        { op: 'sort', by: 'n', dir: 'desc' },
        { op: 'limit', n: 1 },
      ],
      output: { shape: 'grouped' },
    }));
    assert.deepEqual(r.rows, [{ band: 400, n: 4 }]);
  });

  it('E6: half of the payloads are commercial (multi-valued has)', () => {
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { op: 'in', field: 'objectType', values: ['payload'] } },
        { op: 'aggregate', aggs: { s: { fn: 'share', where: { op: 'has', field: 'sectors', value: 'commercial' } } } },
      ],
      output: { shape: 'scalar' },
    }));
    assert.equal(r.value, 0.5);
  });

  it('F1: oldest object still in orbit is Vanguard 1', () => {
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { op: 'in', field: 'status', values: ['in_orbit'] } },
        { op: 'sort', by: 'launchDate', dir: 'asc' },
        { op: 'limit', n: 1 },
      ],
      output: { shape: 'object', columns: ['name', 'launchDate'] },
    }));
    assert.deepEqual(r.rows, [{ noradId: 5, name: 'VANGUARD 1', launchDate: '1958-03-17' }]);
  });

  it('F6: highest apogee ever needs universe all', () => {
    const r = run(prog({
      universe: 'all',
      pipeline: [
        { op: 'sort', by: 'apogeeKm', dir: 'desc' },
        { op: 'limit', n: 1 },
      ],
      output: { shape: 'object', columns: ['name', 'apogeeKm', 'status'] },
    }));
    assert.deepEqual(r.rows, [{ noradId: 12345, name: 'OLD ROCKET', apogeeKm: 40000, status: 'decayed' }]);
    assert.equal(r.meta.scanned, 12);
  });

  it('G2: ISS vs LEO average altitude (compare pipeline)', () => {
    const r = run(prog({
      pipeline: [{ op: 'pick', ids: [25544] }],
      compare: {
        label: 'LEO average',
        pipeline: [
          { op: 'filter', where: { op: 'in', field: 'regime', values: ['LEO'] } },
          { op: 'aggregate', aggs: { avgAlt: { fn: 'avg', of: 'meanAltitudeKm' } } },
        ],
      },
      output: { shape: 'object', columns: ['name', 'meanAltitudeKm'] },
    }));
    assert.equal(r.rows?.[0].meanAltitudeKm, 420);
    assert.equal(r.compare?.shape, 'scalar');
    assert.equal(r.compare?.value, 515);
  });

  it('G3: CIS 1982 is the biggest country×year LEO cohort', () => {
    const r = run(prog({
      pipeline: [
        { op: 'filter', where: { op: 'and', args: [
          { op: 'in', field: 'regime', values: ['LEO'] },
          { op: 'in', field: 'countryCode', values: ['US', 'CIS'] },
        ] } },
        { op: 'groupBy', key: ['countryCode', 'launchYear'], aggs: { n: { fn: 'count' } } },
        { op: 'sort', by: 'n', dir: 'desc' },
        { op: 'limit', n: 2 },
      ],
      output: { shape: 'grouped' },
    }));
    assert.deepEqual(r.rows?.[0], { countryCode: 'CIS', launchYear: 1982, n: 3 });
    assert.deepEqual(r.rows?.[1], { countryCode: 'US', launchYear: 2019, n: 2 });
  });
});

describe('executor — semantics & runtime errors', () => {
  it('nulls sort last regardless of direction', () => {
    const r = run(prog({
      pipeline: [
        { op: 'sort', by: 'totMassKg', dir: 'desc' },
        { op: 'limit', n: 3 },
      ],
      output: { shape: 'table', columns: ['name', 'totMassKg'] },
    }));
    assert.deepEqual(r.rows?.map((row) => row.totMassKg), [420000, 11110, 3000]);
  });

  it('null fields fail filters (skip semantics)', () => {
    const r = run(prog({
      pipeline: [{ op: 'filter', where: { op: '>', args: [{ field: 'totMassKg' }, { lit: 0 }] } }],
    }));
    assert.equal(r.meta.matched, 6);
    assert.deepEqual(r.meta.coverage, [{ field: 'totMassKg', present: 6, total: 10 }]);
  });

  it('pick records missing ids instead of failing', () => {
    const r = run(prog({
      pipeline: [{ op: 'pick', ids: [25544, 99999] }],
    }));
    assert.deepEqual(Array.from(r.ids ?? []), [25544]);
    assert.deepEqual(r.meta.missingIds, [99999]);
  });

  it('timeBinding at resolves evaluatedAt to the bound instant', () => {
    const r = run(prog({
      timeBinding: { mode: 'at', t: '2026-07-10T21:00:00Z' },
      pipeline: [{ op: 'pick', ids: [25544] }],
      output: { shape: 'object', columns: ['name'] },
    }));
    assert.equal(r.meta.evaluatedAt, '2026-07-10T21:00:00.000Z');
  });

  it(`E-OBSERVER: 'user' observer without a location is a typed runtime error`, () => {
    const out = runRaw(prog({
      pipeline: [
        { op: 'filter', where: { op: '>', args: [{ fn: 'elevationDeg', observer: 'user' }, { lit: 0 }] } },
      ],
    }), { observer: null });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error.code, 'E-OBSERVER');
  });

  it(`E-UNIVERSE: universe 'all' without an all-source is a typed runtime error`, () => {
    const out = runRaw(prog({
      universe: 'all',
      pipeline: [{ op: 'filter', where: { op: 'in', field: 'status', values: ['decayed'] } }],
    }), { noAll: true });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error.code, 'E-UNIVERSE');
  });
});
