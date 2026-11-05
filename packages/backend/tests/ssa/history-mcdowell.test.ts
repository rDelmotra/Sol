// McDowell's historical element archive (pre-1980 history backfill): XTLE parsing + conversion (scripts/history/convert-mcdowell.py,
// fixtures = real lines from https://planet4589.org/space/elements/), Brouwer <-> Kozai mean motion against Vallado's SGP4 (satellite.js),
// the downloader's pure helpers (no network), the merge rule and the outlier filter (src/ssa/history/merge.ts), the per-set
// propagation policy with source metadata, and merge-history.ts end to end (1980+ files byte-identical).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as satellite from 'satellite.js';
import { filterOutliers, mergeSources } from '../../src/ssa/history/merge.js';
import { propagatorFor } from '../../src/ssa/history/propagator-policy.js';
import type { Elset } from '../../src/ssa/history/elset-files.js';
import { synthOmm } from './coverage-helpers.js';

const SCRIPTS = fileURLToPath(new URL('../../scripts/history/', import.meta.url));
const CWD = fileURLToPath(new URL('../..', import.meta.url));
const py = (args: string[]) => spawnSync('python3', ['-I', ...args], { encoding: 'utf8', timeout: 120_000 });
const skipPy = py(['-c', 'print(1)']).status === 0 ? false : 'python3 not available';
const dir = mkdtempSync(join(tmpdir(), 'histmcd-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------------ fixtures: real XTLE lines (planet4589.org/space/elements/, May 2022 files)
const FIX: Record<string, string> = {
  // two 1962 sets in S00237's file that carry catalogue number 236 inside the TLE (cross-tag moved by McDowell) and EPHTYPE 2 (Brouwer)
  '00200/S00237': [
    '1 00236U          62057.08551954  .00015913           00000-0 2    25',
    '2 00236  67.3698 186.1440 0361806 141.1992 221.4049 14.45988937 34970',
    '3 00236     1 NOR       SGP4 TEME UTC  Earth                          at/Z60S',
    '1 00236U          62070.57626342  .00014332           00000-0 2    33',
    '2 00236  67.3739 150.8593 0353897 128.2428 234.9793 14.46429254 36929',
    '3 00236     1 NOR       SGP4 TEME UTC  Earth                          at/Z60S',
  ].join('\n'),
  // PROBLEM N (null orbit): skipped
  '00000/S00013': [
    '1 00013U 59002    59059.91389000 0.00000000 +00000-0 +00000-0 0    12',
    '2 00013  89.9624 186.9810 0586082 210.5950 314.4513 14.99859036     3',
    '3 00013     1 UNK    N  SGP4 TEME UTC  Earth                          Disc 1 test report',
  ].join('\n'),
  // XTLE3 (flavour 3, osculating, hyperbolic): skipped
  '00000/S00021': [
    '1S000000021U 59008 1  59277.03750000  .00000000 +00000-0 +00000-0 0      15',
    '2S000000021  65.8218  60.4308   1.0354680  35.1367     0.1838         0.1244537785      00',
    '3S000000021 3 UNK    G  OSC  TEME UTC  Earth                          By hand / Estimate by Jonathan McDowell',
  ].join('\n'),
  // Echo 1, 1965: NDOT2 = +0.21493 rev/day^3 with NDOT 5.34e-6 (implausible: 4e4 / day)
  '00000/S00049': [
    '1 00049U 60009  A 65003.93910693  .00000534 +21493-0 +00000-0 0 02390',
    '2 00049 047.1850 067.9383 0066688 194.6212 165.1848 12.61775618199810',
    '3 00049     1 NOR       SGP4 TEME UTC  Earth                          JCMWWW/S00049',
  ].join('\n'),
};

function writeFixtures(root: string): void {
  for (const [p, text] of Object.entries(FIX)) {
    mkdirSync(join(root, p.split('/')[0]!), { recursive: true });
    writeFileSync(join(root, p), text + '\n');
  }
  writeFileSync(join(root, '00000', '.listing.json'), '[]');
}
const readDay = (out: string, day: string): Array<Record<string, unknown>> => {
  const p = join(out, 'elsets', day.slice(0, 4), `${day}.jsonl.gz`);
  return existsSync(p) ? gunzipSync(readFileSync(p)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

test('convert-mcdowell: file identity (cross-tag), Brouwer -> Kozai, PROBLEM / XTLE3 skipped, NDOT2 kept as provenance', { skip: skipPy }, () => {
  const inp = join(dir, 'in'), out = join(dir, 'out');
  writeFixtures(inp);
  const r = py([join(SCRIPTS, 'convert-mcdowell.py'), '--in', inp, '--out', out, '--to', '1985-12-31']);
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(readFileSync(join(out, 'stats.json'), 'utf8')) as { counts: Record<string, number>; flavours: Record<string, number>; problems: Record<string, number> };
  assert.equal(st.counts.setsRead, 5);
  assert.equal(st.counts.skipXtle3, 1);
  assert.equal(st.counts.skipProblem, 1);
  assert.equal(st.counts.crossTag, 2);
  assert.equal(st.counts.brouwer, 2);
  assert.equal(st.counts.kept, 3);
  assert.equal(st.counts.nddotImplausible, 1);
  const [a] = readDay(out, '1962-02-26');
  assert.ok(a);
  assert.equal(a.NORAD_CAT_ID, 237);                       // the file's object, not the 236 inside the TLE
  assert.equal(a.XTLE_TLE_NUMBER, 236);
  assert.equal(a.EPOCH, '1962-02-26T02:03:08.888Z');       // 62057.08551954
  assert.equal(a.MEAN_MOTION_BROUWER, 14.45988937);
  assert.equal(a.EPHEMERIS_TYPE, 0);
  assert.equal(a.XTLE_EPHTYPE, 2);
  assert.equal(a.MEAN_MOTION_DOT, 0.00015913);
  assert.equal(a.HIST_SRC, 'jcm');
  assert.equal(a.XTLE_ORIGIN, 'NOR');
  assert.equal(a.XTLE_ELTYPE, 'SGP4');
  // i = 67.4 deg (3 cos^2 i - 1 < 0): the Brouwer value is larger than the Kozai value; |difference| ~ 3.7e-4 relative
  const rel = Number(a.MEAN_MOTION) / 14.45988937 - 1;
  assert.ok(rel < -3e-4 && rel > -4.5e-4, String(rel));
  const [e] = readDay(out, '1965-01-03');
  assert.equal(e!.NORAD_CAT_ID, 49);
  assert.equal(e!.MEAN_MOTION_DDOT, 0);
  assert.equal(e!.XTLE_NDDOT, 0.21493);
  assert.equal(readDay(out, '1959-02-28').length, 0);       // PROBLEM N
  // attribution switches: the number inside the TLE, and the source mean motion
  const out2 = join(dir, 'out2');
  assert.equal(py([join(SCRIPTS, 'convert-mcdowell.py'), '--in', inp, '--out', out2, '--to', '1985-12-31', '--identity', 'tle', '--no-brouwer']).status, 0);
  const [b] = readDay(out2, '1962-02-26');
  assert.equal(b!.NORAD_CAT_ID, 236);
  assert.equal(b!.MEAN_MOTION, 14.45988937);
  assert.equal(b!.EPHEMERIS_TYPE, 2);
  // deterministic bytes (gzip mtime 0)
  const out3 = join(dir, 'out3');
  assert.equal(py([join(SCRIPTS, 'convert-mcdowell.py'), '--in', inp, '--out', out3, '--to', '1985-12-31']).status, 0);
  assert.deepEqual(readFileSync(join(out3, 'elsets/1962/1962-02-26.jsonl.gz')), readFileSync(join(out, 'elsets/1962/1962-02-26.jsonl.gz')));
});

test('Brouwer <-> Kozai: inverse of SGP4 initl un-Kozai (reference: satellite.js = Vallado 2006 sgp4unit port); round trip', { skip: skipPy }, () => {
  // Vallado's SGP4 verification set 00005 (SGP4-VER.TLE) and the 1962 fixture above as a TLE
  const tles: Array<[string, string]> = [
    ['1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753', '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667'],
    ['1 00236U          62057.08551954  .00015913  00000-0  00000-0 0    25', '2 00236  67.3698 186.1440 0361806 141.1992 221.4049 14.45988937 34970'],
  ];
  for (const [l1, l2] of tles) {
    const rec = satellite.twoline2satrec(l1, l2);
    const kozai = Number(l2.slice(52, 63));
    const ecc = Number('0.' + l2.slice(26, 33)), inc = Number(l2.slice(8, 16));
    const brouwerRef = (rec.no * 1440) / (2 * Math.PI); // satrec.no after sgp4init = the un-Kozai'd (Brouwer) mean motion, rad/min
    const toK = Number(py([join(SCRIPTS, 'convert-mcdowell.py'), '--kozai-from-brouwer', String(brouwerRef), String(ecc), String(inc)]).stdout);
    const toB = Number(py([join(SCRIPTS, 'convert-mcdowell.py'), '--brouwer-from-kozai', String(kozai), String(ecc), String(inc)]).stdout);
    // constants: ke 0.0743669161 (Spacetrack Report #3) vs satellite.js 60 / sqrt(6378.135^3 / 398600.8): 4e-11 relative
    assert.ok(Math.abs(toB / brouwerRef - 1) < 1e-10, `${l2.slice(2, 7)} brouwer ${toB} vs ${brouwerRef}`);
    assert.ok(Math.abs(toK / kozai - 1) < 1e-10, `${l2.slice(2, 7)} kozai ${toK} vs ${kozai}`);
    assert.ok(Math.abs(brouwerRef / kozai - 1) > 1e-5); // the conversion is not a no-op
  }
});

test('fetch-mcdowell helpers: listing (JSON and HTML), GCAT cut, interval never below 1 s (no network)', { skip: skipPy }, () => {
  const gc = join(dir, 'satcat.tsv');
  writeFileSync(gc, '# Updated\n#JCAT\tSatcat\tPiece\tType\tName\tPLName\tLDate\n'
    + 'S00001\t1\t1957-001A\tR\tR/B\t-\t1957 Oct  4 1928\nS11684\t11684\t1979-104A\tP\tX\t-\t1979 Dec 28\nS11685\t11685\t1980-001A\tP\tY\t-\t1980 Jan  9\n'
    + 'S12000\t12000\t1975-001ZZ\tD\tlate deb\t-\t1975 Jan  1\n');
  const code = `
import runpy, json, sys
m = runpy.run_path(sys.argv[1])
j = m['parse_listing'](b'[{"name":"S00005","size":12,"is_dir":false},{"name":".listing.json","size":1,"is_dir":false},{"name":"x","size":3,"is_dir":true}]')
h = m['parse_listing'](b'<html><a href="./S00008">S00008</a> <a href="../">up</a> <a href="S00009">S00009</a></html>')
f = m['Fetcher'](0.2, 1, 5)
print(json.dumps({'json': j, 'html': h, 'cut': m['gcat_cut'](sys.argv[2], 1979), 'interval': f.interval, 'ua': m['USER_AGENT'], 'folder': m['folder_of'](11684)}))
`;
  const r = py(['-c', code, join(SCRIPTS, 'fetch-mcdowell.py'), gc]);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout) as { json: unknown; html: unknown; cut: number; interval: number; ua: string; folder: string };
  assert.deepEqual(o.json, [{ name: 'S00005', size: 12 }]);
  assert.deepEqual(o.html, [{ name: 'S00008', size: null }, { name: 'S00009', size: null }]);
  assert.equal(o.cut, 11684); // smallest number launched after 1979, minus one (the late-catalogued 12000 does not move it)
  assert.equal(o.interval, 1);
  assert.ok(!o.ua.includes('@'));
  assert.equal(o.folder, '11600');
});

// ------------------------------------------------------------------ merge rule and outlier filter
const T0 = Date.UTC(1965, 5, 1, 3);
const DAY = 86_400_000;
const set = (id: number, t: number, over: Record<string, unknown> = {}): Elset => ({ noradId: id, epochMs: t, omm: synthOmm(id, new Date(t).toISOString(), over) });

test('mergeSources (matched): McDowell versions of the mirror epochs, moved cross-tags, McDowell-only object-years, mirror after the cut', () => {
  const mirror = [set(1, T0), set(1, T0 + DAY), set(3, T0 + 2 * DAY), set(4, T0), set(1, Date.UTC(1980, 0, 2))];
  const jcm = [
    set(1, T0 + 300, { HIST_SRC: 'jcm' }), set(1, T0 + DAY, { HIST_SRC: 'jcm' }), set(1, T0 + 5 * DAY, { HIST_SRC: 'jcm' }), // 300 ms off: matched; +5 d: McDowell-only
    set(2, T0 + 2 * DAY, { HIST_SRC: 'jcm', XTLE_TLE_NUMBER: 3 }), set(2, T0 + 3 * DAY, { HIST_SRC: 'jcm' }),             // 2 has no mirror sets that year
    set(1, Date.UTC(1980, 0, 2), { HIST_SRC: 'jcm' }),
  ];
  const { sets, stats } = mergeSources(mirror, jcm, { cutYear: 1980 });
  const tag = (s: Elset) => `${s.noradId}@${(s.epochMs - T0) / DAY}:${s.omm.HIST_SRC ?? 'mirror'}`;
  const got = sets.map(tag).sort();
  assert.deepEqual(got, [
    `1@${(Date.UTC(1980, 0, 2) - T0) / DAY}:mirror`, // after the cut: the mirror only
    `1@${300 / DAY}:jcm`, '1@1:jcm',                // matched McDowell versions; the McDowell-only +5 d set is dropped
    '2@2:jcm', '2@3:jcm',                           // object-year without mirror sets: all McDowell sets
    '3@2:mirror',                                   // McDowell has no 3 that year: the mirror's
    '4@0:mirror',
  ].sort());
  assert.equal(stats.jcmUnmatched, 1);
  // a moved cross-tag (2's set with number 3 at 3's mirror epoch) is matched through XTLE_TLE_NUMBER when 2 has mirror sets too
  const m2 = mergeSources([...mirror, set(2, T0 + 9 * DAY)], jcm, { cutYear: 1980 });
  assert.ok(m2.sets.some((s) => s.noradId === 2 && s.epochMs === T0 + 2 * DAY && s.omm.HIST_SRC === 'jcm'));
  assert.ok(!m2.sets.some((s) => s.noradId === 2 && s.epochMs === T0 + 3 * DAY)); // unmatched
  // 'union' never brings a moved set back under the old number... but adds the mirror's other epochs
  const u = mergeSources(mirror, [...jcm, set(3, T0 + 7 * DAY, { HIST_SRC: 'jcm' })], { cutYear: 1980, rule: 'union' });
  assert.ok(!u.sets.some((s) => s.noradId === 3 && s.epochMs === T0 + 2 * DAY));
});

/** A consistent series: one high orbit (2 rev/day, small J2 drift), the mean anomaly advanced by n dt; optionally one set displaced. */
function series(id: number, n: number, badIdx: number[] = []): Elset[] {
  const out: Elset[] = [];
  for (let k = 0; k < n; k++) {
    const t = T0 + k * DAY;
    const M = (40 + 2 * 360 * k + (badIdx.includes(k) ? 90 : 0)) % 360;
    out.push(set(id, t, { MEAN_MOTION: 2, ECCENTRICITY: 0.001, INCLINATION: 53, BSTAR: 0, MEAN_ANOMALY: M }));
  }
  return out;
}

test('filterOutliers: drops a set both (mutually consistent) neighbours disagree with; never with one neighbour; never with two bad in a row', () => {
  const thr = () => 300;
  const r = filterOutliers(series(7, 6, [2]), thr, 5);
  assert.deepEqual(r.dropped.map((s) => (s.epochMs - T0) / DAY), [2]);
  assert.equal(r.kept.length, 5);
  assert.equal(filterOutliers(series(7, 6), thr, 5).dropped.length, 0);           // clean series: nothing dropped
  assert.equal(filterOutliers(series(7, 6, [5]), thr, 5).dropped.length, 0);      // last set: one neighbour only
  assert.equal(filterOutliers(series(7, 6, [2, 3]), thr, 5).dropped.length, 0);   // neighbours disagree with each other
  assert.equal(filterOutliers(series(7, 6, [2]), thr, 0.5).dropped.length, 0);    // neighbours further than maxGapDays
  assert.equal(filterOutliers(series(7, 6, [2]), () => Number.NaN, 5).dropped.length, 0);
});

test('propagatorFor: an explicit SGP label picks SGP in any era; the SGP4 label (the XTLE default) follows the era rule', () => {
  const pol = { minDriftKmD2: 0, deepSpace: true };
  const o = synthOmm(9, '1965-06-01T00:00:00Z', { BSTAR: 0, MEAN_MOTION_DOT: 1e-4, MEAN_MOTION: 15.5 });
  assert.equal(propagatorFor({ ...o, XTLE_ELTYPE: 'SGP' }, undefined), 'sgp');
  assert.equal(propagatorFor({ ...o, BSTAR: 1e-4, XTLE_ELTYPE: 'SGP' }, undefined), 'sgp');
  assert.equal(propagatorFor({ ...o, XTLE_ELTYPE: 'SGP4' }, pol), 'sgp');
  assert.equal(propagatorFor({ ...o, XTLE_ELTYPE: 'SGP4' }, undefined), undefined);
  assert.equal(propagatorFor({ ...o, BSTAR: 1e-4, XTLE_ELTYPE: 'SGP4' }, pol), undefined);
});

// ------------------------------------------------------------------ merge-history.ts end to end
const writeGz = (p: string, rows: Array<Record<string, unknown>>): void => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')); };

test('merge-history --merge: pre-cut days merged + filtered, post-cut day files and post-cut objects byte-identical', () => {
  const mir = join(dir, 'm-mirror'), jcm = join(dir, 'm-jcm'), out = join(dir, 'm-out');
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const ser = series(7, 6, [2]);
  for (const s of ser) writeGz(join(mir, '1965', `${day(s.epochMs)}.jsonl.gz`), [s.omm]);
  for (const s of ser) if (s.epochMs !== T0 + 2 * DAY) writeGz(join(jcm, '1965', `${day(s.epochMs)}.jsonl.gz`), [{ ...s.omm, HIST_SRC: 'jcm' }]);
  const post = synthOmm(8, '1980-03-01T00:00:00.000Z');
  writeGz(join(mir, '1980', '1980-03-01.jsonl.gz'), [post]);
  const objs = [
    { noradId: 7, name: 'SEVEN', objectType: 'debris', rcsSize: null, launchDate: '1965-01-01', decayDate: null, intlDesignator: null, firstEpoch: '1965-06-01T03:00:00.000Z', lastEpoch: '1965-06-06T03:00:00.000Z', nSets: 6 },
    { noradId: 8, name: 'EIGHT', objectType: 'debris', rcsSize: null, launchDate: '1980-01-01', decayDate: null, intlDesignator: null, firstEpoch: '1980-03-01T00:00:00.000Z', lastEpoch: '1980-03-01T00:00:00.000Z', nSets: 1 },
  ];
  writeFileSync(join(dir, 'm-objects.jsonl'), objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(SCRIPTS, 'merge-history.ts'), '--merge', '--mirror', mir, '--jcm', jcm, '--objects', join(dir, 'm-objects.jsonl'), '--out', out, '--filter-k', '1'],
    { cwd: CWD, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // the bad mirror set of 1965-06-03 is gone (McDowell has no such epoch -> the object-year is McDowell's 5 sets); the rest are McDowell's
  assert.equal(existsSync(join(out, 'elsets/1965/1965-06-03.jsonl.gz')), false);
  const d4 = gunzipSync(readFileSync(join(out, 'elsets/1965/1965-06-04.jsonl.gz'))).toString('utf8');
  assert.match(d4, /"HIST_SRC":"jcm"/);
  assert.deepEqual(readFileSync(join(out, 'elsets/1980/1980-03-01.jsonl.gz')), readFileSync(join(mir, '1980/1980-03-01.jsonl.gz')));
  const lines = gunzipSync(readFileSync(join(out, 'objects.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean);
  assert.equal(lines[1], JSON.stringify(objs[1]));               // first seen after the cut: unchanged
  assert.equal((JSON.parse(lines[0]!) as { nSets: number }).nSets, 5);
  // restart: markers -> nothing recomputed, same outputs
  const r2 = spawnSync(process.execPath, ['--import', 'tsx', join(SCRIPTS, 'merge-history.ts'), '--merge', '--mirror', mir, '--jcm', jcm, '--objects', join(dir, 'm-objects.jsonl'), '--out', out],
    { cwd: CWD, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(gunzipSync(readFileSync(join(out, 'objects.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean)[0], lines[0]);
});
