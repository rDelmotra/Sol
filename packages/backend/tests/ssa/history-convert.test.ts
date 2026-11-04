// scripts/history/convert.py, era-stats.py and --verify on a hand-built mini mirror (python3 + duckdb required; skipped otherwise):
// day bucketing at UTC boundaries (incl. the year boundary across two yearly files), designator conversion, FLOAT widening, duplicate and
// non-finite rows, object metadata (type vocabulary, rcs size classes, GCAT fallback), restart, and the Space-Track comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('../../scripts/history/', import.meta.url));
const py = (args: string[], input?: string) => spawnSync('python3', ['-I', ...args], { encoding: 'utf8', input, timeout: 120_000 });
const have = py(['-c', 'import duckdb']).status === 0;
const skip = have ? false : 'python3 with duckdb not available';

const dir = mkdtempSync(join(tmpdir(), 'histconv-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const BUILD = `
import duckdb, sys, os
d = sys.argv[1]
os.makedirs(d + '/mirror', exist_ok=True)
con = duckdb.connect(); con.execute("SET TimeZone='UTC'")
con.execute("""CREATE TABLE t (norad_id INTEGER, epoch TIMESTAMPTZ, inclination FLOAT, raan FLOAT, eccentricity FLOAT, arg_perigee FLOAT, mean_anomaly FLOAT,
  mean_motion DOUBLE, mean_motion_dot DOUBLE, bstar DOUBLE, intl_designator VARCHAR, altitude_km FLOAT)""")
rows = [
 (25544, '2019-12-31 23:59:59.5+00', 51.6416, 10.5, 0.0005, 20.25, 30.125, 15.5, 1e-5, 3e-4, '98067A', 400.0),
 (25544, '2020-01-01 00:00:00+00', 51.6416, 10.5, 0.0005, 20.25, 30.125, 15.5, 1e-5, 3e-4, '98067A', 400.0),
 (25544, '2020-03-01 23:59:59.999999+00', 51.6416, 10.5, 0.0005, 20.25, 30.125, 15.5, 1e-5, 3e-4, '98067A', 400.0),
 (25544, '2020-03-02 00:00:00+00', 51.6417, 10.6, 0.0005, 20.25, 30.125, 15.5, 1e-5, 3e-4, '98067A', 400.0),
 (25544, '2020-03-02 12:00:00.123456+00', 51.6418, 10.7, 0.0005, 20.25, 30.125, 15.5, 1e-5, 3e-4, '98067A', 400.0),
 (43013, '2020-03-02 05:00:00+00', 98.7, 100.0, 0.0001, 90.0, 270.0, 14.2, 0.0, 1e-4, '17073A', 800.0),
 (1, '2020-03-02 06:00:00+00', 34.2, 1.0, 0.1, 2.0, 3.0, 10.8, 0.0, 0.0, '57001A', 650.0),
 (2, '2020-03-02 07:00:00+00', 32.8, 1.0, 0.1, 2.0, 3.0, 11.9, 0.0, 0.0, '56001A', 650.0),
 (3, '2020-03-02 08:00:00+00', 32.8, 1.0, 1.5, 2.0, 3.0, 11.9, 0.0, 0.0, '00001A', 650.0),
 (99999, '2020-03-03 08:00:00+00', 10.0, 1.0, 0.1, 2.0, 3.0, 12.0, 0.0, 0.0, None, 650.0),
 (4, '2020-03-03 09:00:00+00', 10.0, 1.0, 0.1, 2.0, 3.0, float('nan'), 0.0, 0.0, '20001A', 650.0),
]
con.executemany("INSERT INTO t VALUES (?, CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
con.executemany("INSERT INTO t VALUES (?, CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [rows[5]])  # duplicate
for y in (2019, 2020):
    con.execute(f"COPY (SELECT * FROM t WHERE year(epoch) = {y}) TO '{d}/mirror/tle_{y}.parquet' (FORMAT PARQUET)")
con.execute("""CREATE TABLE s (object_name VARCHAR, intl_designator VARCHAR, norad_id INTEGER, object_type VARCHAR, ops_status VARCHAR, owner VARCHAR,
  launch_date DATE, launch_site VARCHAR, decay_date DATE, period_min DOUBLE, inclination DOUBLE, apogee_km DOUBLE, perigee_km DOUBLE, rcs_m2 DOUBLE,
  data_status VARCHAR, orbit_center VARCHAR, orbit_type VARCHAR)""")
con.execute("""INSERT INTO s VALUES
 ('ISS (ZARYA)', '1998-067A', 25544, 'PAYLOAD', '+', 'ISS', DATE '1998-11-20', 'TTMTR', NULL, 92.0, 51.6, 420, 410, 399.05, '', 'EA', 'ORB'),
 ('NOAA 20', '2017-073A', 43013, 'PAYLOAD', '+', 'US', DATE '2017-11-18', 'AFWTR', NULL, 101.0, 98.7, 830, 820, 0.5, '', 'EA', 'ORB'),
 ('DEB SMALL', '1957-001B', 1, 'DEBRIS', '', 'US', DATE '1957-01-01', 'AFETR', DATE '2019-01-01', 100.0, 34.0, 700, 600, 0.05, '', 'EA', 'ORB'),
 ('R/B EDGE', '1956-001A', 2, 'ROCKET BODY', '', 'US', NULL, 'AFETR', NULL, 100.0, 34.0, 700, 600, 1.0, '', 'EA', 'ORB'),
 ('R/B EDGE2', '2000-001A', 3, 'ROCKET BODY', '', 'US', NULL, 'AFETR', NULL, 100.0, 34.0, 700, 600, 1.0001, '', 'EA', 'ORB'),
 (NULL, NULL, 99999, 'TBA', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '', 'EA', 'ORB'),
 ('NO MIRROR', '2001-001A', 77777, 'UNKNOWN', '', 'US', DATE '2001-01-01', 'AFETR', NULL, 100.0, 34.0, 700, 600, 0.1, '', 'EA', 'ORB')""")
con.execute(f"COPY s TO '{d}/satcat.parquet' (FORMAT PARQUET)")
os.makedirs(d + '/gcat', exist_ok=True)
open(d + '/gcat/satcat.tsv', 'w').write('# Updated 2026 Jan  1\\n#JCAT\\tSatcat\\tPiece\\tType\\tName\\tPLName\\tLDate\\tParent\\tSDate\\tPrimary\\tDDate\\tStatus\\n'
  'S099999\\t99999\\t2001-005B\\tR1\\tGCAT RB NAME\\t-\\t2001 Feb  3 1200\\t-\\t-\\tEarth\\t2005 Jun  7 0000?\\tR\\n')
`;

let out = '';
test('convert: day files, bucketing, designators, float widening, duplicates / non-finite dropped, per-year counts', { skip }, () => {
  assert.equal(py(['-c', BUILD, dir]).status, 0);
  out = join(dir, 'out');
  const r = py([join(SCRIPTS, 'convert.py'), '--mirror', join(dir, 'mirror'), '--satcat', join(dir, 'satcat.parquet'), '--gcat', join(dir, 'gcat'), '--out', out, '--jobs', '2', '--threads', '2']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^2019 +1 +1 +0 +1$/m);
  assert.match(r.stdout, /^2020 +11 +8 +3 +4$/m); // 11 rows: 1 duplicate, 1 with e >= 1 and 1 NaN dropped
  const day = (d: string): Array<Record<string, unknown>> => gunzipSync(readFileSync(join(out, 'elsets', d.slice(0, 4), `${d}.jsonl.gz`))).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(day('2019-12-31').length, 1);
  assert.equal(day('2019-12-31')[0]!.EPOCH, '2019-12-31T23:59:59.500Z');
  assert.deepEqual(day('2020-01-01').map((x) => x.EPOCH), ['2020-01-01T00:00:00.000Z']);
  assert.deepEqual(day('2020-03-01').map((x) => x.EPOCH), ['2020-03-01T23:59:59.999Z']);
  const d2 = day('2020-03-02');
  assert.deepEqual(d2.map((x) => [x.NORAD_CAT_ID, x.EPOCH]), [
    [1, '2020-03-02T06:00:00.000Z'], [2, '2020-03-02T07:00:00.000Z'], [25544, '2020-03-02T00:00:00.000Z'], [25544, '2020-03-02T12:00:00.123Z'], [43013, '2020-03-02T05:00:00.000Z'],
  ]);
  const iss = d2[2]!;
  assert.deepEqual(Object.keys(iss), ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY',
    'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT']);
  assert.equal(iss.OBJECT_NAME, 'ISS (ZARYA)'); assert.equal(iss.OBJECT_ID, '1998-067A');
  assert.equal(iss.INCLINATION, 51.6417); // FLOAT 51.6417 widened through its decimal text, not 51.64170074462891
  assert.equal(iss.RA_OF_ASC_NODE, 10.6); assert.equal(iss.ECCENTRICITY, 0.0005);
  assert.equal(iss.MEAN_MOTION, 15.5); assert.equal(iss.BSTAR, 3e-4); assert.equal(iss.MEAN_MOTION_DOT, 1e-5);
  assert.equal(iss.MEAN_MOTION_DDOT, 0); assert.equal(iss.EPHEMERIS_TYPE, 0); assert.equal(iss.CLASSIFICATION_TYPE, 'U'); assert.equal(iss.ELEMENT_SET_NO, 0); assert.equal(iss.REV_AT_EPOCH, 0);
  assert.equal(d2[0]!.OBJECT_ID, '1957-001A'); // 57 -> 1957
  assert.equal(d2[1]!.OBJECT_ID, '2056-001A'); // 56 -> 2056
  assert.equal(d2[4]!.OBJECT_ID, '2017-073A'); assert.equal(d2[4]!.OBJECT_NAME, 'NOAA 20');
  assert.equal(d2[0]!.OBJECT_NAME, 'DEB SMALL');
  // the ecc >= 1 row (norad 3) and the NaN row (norad 4) are dropped; norad 99999 (no designator) takes the satcat's absence -> null, name from GCAT
  const d3 = day('2020-03-03');
  assert.deepEqual(d3.map((x) => x.NORAD_CAT_ID), [99999]);
  assert.equal(d3[0]!.OBJECT_NAME, 'GCAT RB NAME');
  // markers and restart
  assert.ok(existsSync(join(out, '.work', 'months', '2020-03.json')));
  const again = py([join(SCRIPTS, 'convert.py'), '--mirror', join(dir, 'mirror'), '--satcat', join(dir, 'satcat.parquet'), '--out', out, '--jobs', '1', '--threads', '1', '--no-objects']);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /2020-03: /, 'finished months are skipped');
  assert.deepEqual(readdirSync(join(out, 'elsets', '2020')).sort(), ['2020-01-01.jsonl.gz', '2020-03-01.jsonl.gz', '2020-03-02.jsonl.gz', '2020-03-03.jsonl.gz']);
});

test('convert: objects file (vocabulary, rcs classes, GCAT fallback, first / last epoch)', { skip }, () => {
  const objs = new Map(gunzipSync(readFileSync(join(out, 'objects.jsonl.gz'))).toString().split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.noradId as number, o] as const; }));
  const iss = objs.get(25544)!;
  assert.deepEqual([iss.name, iss.objectType, iss.rcsSize, iss.launchDate, iss.decayDate, iss.intlDesignator, iss.nSets], ['ISS (ZARYA)', 'satellite', 'LARGE', '1998-11-20', null, '1998-067A', 5]);
  assert.equal(iss.firstEpoch, '2019-12-31T23:59:59.500Z'); assert.equal(iss.lastEpoch, '2020-03-02T12:00:00.123Z');
  assert.equal(objs.get(43013)!.rcsSize, 'MEDIUM');
  assert.deepEqual([objs.get(1)!.objectType, objs.get(1)!.rcsSize, objs.get(1)!.decayDate], ['debris', 'SMALL', '2019-01-01']);
  assert.deepEqual([objs.get(2)!.objectType, objs.get(2)!.rcsSize], ['rocket_body', 'MEDIUM']); // 1.0 m2 is MEDIUM
  assert.equal(objs.get(3)!.rcsSize, 'LARGE');
  const g = objs.get(99999)!; // Space-Track row empty / TBA: GCAT fills name, type, dates
  assert.deepEqual([g.name, g.objectType, g.launchDate, g.decayDate], ['GCAT RB NAME', 'rocket_body', '2001-02-03', '2005-06-07']);
  const nm = objs.get(77777)!; // in the satcat, not in the mirror
  assert.deepEqual([nm.objectType, nm.rcsSize, nm.nSets, nm.firstEpoch], ['unknown', 'MEDIUM', 0, null]);
});

test('--verify against a Space-Track gp_history dump: matches within 1 ms, reports deltas and the unmatched', { skip }, () => {
  const st = [
    { NORAD_CAT_ID: '25544', EPOCH: '2020-03-02T12:00:00.123456', MEAN_MOTION: '15.50000000', ECCENTRICITY: '0.0005000', INCLINATION: '51.6418', RA_OF_ASC_NODE: '10.7000', ARG_OF_PERICENTER: '20.2500', MEAN_ANOMALY: '30.1250', BSTAR: '0.00030000', MEAN_MOTION_DOT: '0.00001000', MEAN_MOTION_DDOT: '0' },
    { NORAD_CAT_ID: '25544', EPOCH: '2020-03-02T00:00:00.000500', MEAN_MOTION: '15.50000100', ECCENTRICITY: '0.0005000', INCLINATION: '51.6417', RA_OF_ASC_NODE: '10.6000', ARG_OF_PERICENTER: '20.2500', MEAN_ANOMALY: '30.1250', BSTAR: '0.00030000', MEAN_MOTION_DOT: '0.00001000', MEAN_MOTION_DDOT: '0' },
    { NORAD_CAT_ID: '25544', EPOCH: '2020-03-02T18:00:00.000000', MEAN_MOTION: '15.5', ECCENTRICITY: '0.0005', INCLINATION: '51.6', RA_OF_ASC_NODE: '10', ARG_OF_PERICENTER: '20', MEAN_ANOMALY: '30', BSTAR: '0.0003', MEAN_MOTION_DOT: '0.00001', MEAN_MOTION_DDOT: '0' },
  ];
  const f = join(dir, 'st.json');
  writeFileSync(f, JSON.stringify(st));
  const r = py([join(SCRIPTS, 'convert.py'), '--verify', f, '--mirror', join(dir, 'mirror')]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Space-Track rows : 3/);
  assert.match(r.stdout, /with a mirror row.*: 2 \(66\.67 %\)/);
  assert.match(r.stdout, /without one : 1/);
  assert.match(r.stdout, /max epoch difference : 0 us|max epoch difference : \d+ us/);
  assert.match(r.stdout, /MEAN_MOTION +1e-06/); // the 1e-6 offset of the second row
});

test('era-stats: gaps per year and the suggested window table', { skip }, () => {
  const j = join(dir, 'era.json');
  const r = py([join(SCRIPTS, 'era-stats.py'), '--mirror', join(dir, 'mirror'), '--jobs', '1', '--threads', '1', '--era-json', j]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^2020 /m);
  const t = JSON.parse(readFileSync(j, 'utf8')) as Array<{ fromYear: number; windowDays: number }>;
  assert.ok(t.some((x) => x.fromYear === 2020 && x.windowDays >= 30));
});
