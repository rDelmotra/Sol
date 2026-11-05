// The history backfill's propagation model (pre-1980 element sets without B*: SGP, orbital-core sgp.ts) and what it reaches:
//   policy (propagator-policy.ts) per era, the Prop abstraction (SGP4 path = satellite.sgp4 exactly), SGP vs SGP4 on drag-free orbits,
//   the chain check with the era model, the era table, and build-range end to end on a 1965 world (manifest propagators + accuracy,
//   elements.jump payload `acc`, era jump thresholds).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as satellite from 'satellite.js';
import { sgpInit, sgpElementsFromOmm } from '@orbitwatch/orbital-core';
import { makeProp, propagateAt } from '../../src/ssa/encounter.js';
import { assignPropagators, dragDriftKmD2, propagatorFor } from '../../src/ssa/history/propagator-policy.js';
import { ERA_TABLE, eraFor, validateEraTable } from '../../src/ssa/history/era.js';
import { chainPairs, summarizeChain } from '../../src/ssa/history/chain.js';
import { isoDayOf } from '../../src/ssa/history/catalog-files.js';
import { deriveChanges } from '../../src/ssa/events/changes.js';
import { readManifest } from '../../src/ssa/coverage/store.js';
import type { ChangeObject } from '../../src/ssa/events/types.js';
import { synthOmm } from './coverage-helpers.js';
import { DAY, iso, writeWorld, type SynthSet } from './history-helpers.js';
import { runBuildRange } from './history-run.js';
import type { ObjectMeta } from '../../src/ssa/history/elset-files.js';

const ERA_EARLY = { minDriftKmD2: 0, deepSpace: true };
const ERA_LATE = { minDriftKmD2: 3, deepSpace: false };
const leo = (over: Record<string, unknown> = {}) => synthOmm(7, '1965-06-10T03:00:00.000Z', { MEAN_MOTION: 15.6, ECCENTRICITY: 0.005, INCLINATION: 65, BSTAR: 0, MEAN_MOTION_DOT: 2e-4, ...over });
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('policy: B* != 0 and no-policy eras are SGP4; deep space only when the era says so; the drift threshold', () => {
  assert.equal(propagatorFor(leo(), undefined), undefined);
  assert.equal(propagatorFor(leo({ BSTAR: 1e-4 }), ERA_EARLY), undefined);
  assert.equal(propagatorFor(leo(), ERA_EARLY), 'sgp');
  assert.equal(propagatorFor(leo({ MEAN_MOTION_DOT: 0 }), ERA_EARLY), 'sgp');
  const geo = leo({ MEAN_MOTION: 1.0027, MEAN_MOTION_DOT: -1e-6 });
  assert.equal(propagatorFor(geo, ERA_EARLY), 'sgp');
  assert.equal(propagatorFor(geo, ERA_LATE), undefined);
  // 2 pi a |ndot/2|: 2e-4 rev/d^2 at ~6600 km is ~8.3 km/d^2 (>= 3), 2e-5 is ~0.8 (< 3)
  const aKm = Math.cbrt(398600.4418 / ((15.6 * 2 * Math.PI) / 86400) ** 2);
  assert.ok(Math.abs(dragDriftKmD2(leo()) - 2 * Math.PI * aKm * 2e-4) < 1e-9);
  assert.equal(propagatorFor(leo(), ERA_LATE), 'sgp');
  assert.equal(propagatorFor(leo({ MEAN_MOTION_DOT: 2e-5 }), ERA_LATE), undefined);
  assert.equal(propagatorFor(leo({ MEAN_MOTION_DOT: -2e-4 }), ERA_LATE), 'sgp');
});

test('assignPropagators leaves SGP4 objects untouched (same object, no propagator field)', () => {
  const objs: ChangeObject[] = [{ noradId: 1, name: 'A', regime: 'LEO', omm: leo({ BSTAR: 1e-4 }) }, { noradId: 2, name: 'B', regime: 'LEO', omm: leo() }];
  assert.equal(assignPropagators(objs, undefined), objs);
  const r = assignPropagators(objs, ERA_EARLY);
  assert.equal(r[0], objs[0]);
  assert.ok(!('propagator' in r[0]!));
  assert.equal(r[1]!.propagator, 'sgp');
  assert.ok(!('propagator' in objs[1]!), 'input not mutated');
});

test('Prop: the default path is satellite.sgp4 exactly; SGP needs usable elements', () => {
  const omm = leo({ BSTAR: 3e-4 });
  const p = makeProp(omm)!, q = makeProp(omm, 'sgp4')!;
  assert.equal(p.sgp, undefined);
  assert.equal(q.sgp, undefined);
  for (const t of [-600, 0, 33.3, 1440, 5000]) assert.deepEqual(propagateAt(p, t), satellite.sgp4(p.satrec, t));
  const s = makeProp(omm, 'sgp')!;
  assert.ok(s.sgp);
  assert.equal(s.epochMs, p.epochMs);
  assert.equal(makeProp(leo({ ECCENTRICITY: 1.2 }), 'sgp'), null);
});

test('SGP agrees with SGP4 on drag-free near-Earth orbits (< 1.7 km after 1 day, < 4.1 km after 3), and drifts by 2 pi (ndot/2) t^2 when SGP4 (B* = 0) does not', () => {
  for (const [mm, e, inc] of [[16.0, 0.001, 51.6], [14.3, 0.001, 98.7], [16.05824518, 0.0086731, 72.8435], [12.4, 0.01, 65]] as const) {
    const omm = leo({ MEAN_MOTION: mm, ECCENTRICITY: e, INCLINATION: inc, MEAN_MOTION_DOT: 0 });
    const a = makeProp(omm)!, b = makeProp(omm, 'sgp')!;
    for (const t of [0, 90, 1440, 4320]) {
      const d = dist(propagateAt(a, t)!.position, propagateAt(b, t)!.position);
      assert.ok(d < 0.5 + t / 1200, `n=${mm} t=${t}: SGP vs SGP4 ${d.toFixed(2)} km`);
    }
  }
  const nd2 = 2e-4;
  const omm = leo({ MEAN_MOTION_DOT: nd2 });
  const s4 = makeProp(omm)!, sg = makeProp(omm, 'sgp')!;
  const d = dist(propagateAt(s4, 1440)!.position, propagateAt(sg, 1440)!.position);
  const aKm = Math.cbrt(398600.4418 / ((15.6 * 2 * Math.PI) / 86400) ** 2);
  const want = aKm * 2 * Math.PI * nd2; // 1 day
  assert.ok(Math.abs(d - want) / want < 0.15, `drag drift ${d.toFixed(2)} km vs ${want.toFixed(2)} km`);
});

// ---------------------------------------------------------------- a 1965 world: decaying B* = 0 objects whose sets follow SGP's secular theory
const Y = '1965-06-';
const T0 = Date.parse(`${Y}05T00:00:00Z`);
function world1965(): { sets: SynthSet[]; objects: ObjectMeta[] } {
  const sets: SynthSet[] = [], objects: ObjectMeta[] = [];
  for (let i = 0; i < 24; i++) {
    const id = 1000 + i;
    const n0 = 15.2 + (i % 6) * 0.15, nd2 = 1e-4 * (1 + (i % 4)), inc = [65, 48, 33, 72][i % 4]!;
    const base = synthOmm(id, iso(T0), { MEAN_MOTION: n0, ECCENTRICITY: 0.004, INCLINATION: inc, RA_OF_ASC_NODE: (i * 41) % 360, ARG_OF_PERICENTER: 30, MEAN_ANOMALY: (i * 77) % 360, BSTAR: 0, MEAN_MOTION_DOT: nd2 });
    const rec = sgpInit(sgpElementsFromOmm(base))!;
    for (let k = 0; k < 8; k++) {
      const tD = k * 0.9 + (i % 3) * 0.05, tMin = tD * 1440;
      let n = n0 + 2 * nd2 * tD, M = (base.MEAN_ANOMALY as number) + 360 * (n0 * tD + nd2 * tD * tD);
      if (id === 1003 && k >= 6) { n += 0.3; M += 0; } // a manoeuvre between sets 5 and 6 (semi-major axis down ~90 km)
      sets.push({ noradId: id, epochMs: T0 + tD * DAY, omm: { ...base, EPOCH: iso(T0 + tD * DAY), MEAN_MOTION: +n.toFixed(8), MEAN_ANOMALY: ((M % 360) + 360) % 360,
        RA_OF_ASC_NODE: (((base.RA_OF_ASC_NODE as number) + (rec.dO * tMin * 180) / Math.PI) % 360 + 360) % 360,
        ARG_OF_PERICENTER: (((base.ARG_OF_PERICENTER as number) + (rec.dw * tMin * 180) / Math.PI) % 360 + 360) % 360 } });
    }
    objects.push({ noradId: id, name: `OLD-${id}`, objectType: i % 2 ? 'debris' : 'satellite', rcsSize: null, launchDate: '1965-01-01', decayDate: null, intlDesignator: `1965-0${i}A`, firstEpoch: iso(T0) });
  }
  sets.sort((a, b) => a.noradId - b.noradId || a.epochMs - b.epochMs);
  return { sets, objects };
}
const w65 = world1965();
const dir = mkdtempSync(join(tmpdir(), 'histprop-'));
const files = writeWorld(dir, w65);
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('chain check: the era model (SGP) follows decaying B* = 0 sets; SGP4 falls behind along-track', () => {
  const kindOf = (s: SynthSet) => propagatorFor(s.omm, eraFor(isoDayOf(s.epochMs)).sgp);
  const clean = w65.sets.filter((s) => s.noradId !== 1003);
  const a = summarizeChain(chainPairs(clean, 5).pairs, 0), b = summarizeChain(chainPairs(clean, 5, kindOf).pairs, 0);
  assert.ok(a.medianKm > 5, `SGP4 median ${a.medianKm}`);
  assert.ok(b.medianKm < a.medianKm / 5, `SGP ${b.medianKm} vs SGP4 ${a.medianKm}`);
});

test('era table: measured rows, SGP policy and accuracy before 1980, production from 1980, --print-era round trip, old era files warned', () => {
  assert.equal(eraFor('1959-02-01').fromYear, 1959);
  assert.equal(eraFor('1969-12-31').fromYear, 1969);
  assert.equal(eraFor('1900-01-01').fromYear, 1959);
  assert.equal(eraFor('1965-06-10').windowDays, 49);
  assert.equal(eraFor('1966-06-10').windowDays, 88);
  for (const r of ERA_TABLE.filter((x) => x.fromYear < 1980)) {
    assert.ok(r.sgp && r.accuracy && r.accuracy.medianKm > 0 && r.accuracy.p95Km >= r.accuracy.medianKm, `row ${r.fromYear}`);
    assert.ok(r.jumpDaKm >= 1 && r.jumpDposKm >= 16.3);
  }
  const modern = eraFor('2026-10-12');
  assert.deepEqual([modern.windowDays, modern.jumpDposKm, modern.jumpDaKm, modern.sgp, modern.accuracy], [30, 16.3, 1.0, undefined, undefined]);
  assert.equal(eraFor('1985-01-01'), modern);
  assert.throws(() => validateEraTable([{ fromYear: 1960, windowDays: 30, jumpDposKm: 1, jumpDaKm: 1, sgp: { minDriftKmD2: -1, deepSpace: true } }]));
  const r = runBuildRange(['--print-era']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(validateEraTable(JSON.parse(r.stdout)), JSON.parse(JSON.stringify(ERA_TABLE)));
  const old = join(dir, 'old-era.json');
  writeFileSync(old, JSON.stringify([{ fromYear: 1959, windowDays: 34, jumpDposKm: 16.3, jumpDaKm: 1 }]));
  const c = runBuildRange(['--check-chain', '--elsets', files.elsets, '--years', '1965', '--start', '06-05', '--window-days', '8', '--era-file', old]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stderr, /no 'sgp' policy/);
});

test('jump payload quotes the era accuracy only when given', () => {
  const a = { noradId: 9, name: 'X', regime: 'LEO', omm: leo({ BSTAR: 1e-4, MEAN_MOTION_DOT: 0 }) };
  const b = { ...a, omm: { ...a.omm, EPOCH: '1965-06-11T03:00:00.000Z', MEAN_MOTION: 15.9 } };
  const t0 = Date.parse('1965-06-11T00:00:00Z');
  const plain = deriveChanges([a], [b], t0).rows.find((x) => x.kind === 'elements.jump')!;
  assert.ok(plain && !('acc' in plain.payload));
  const withAcc = deriveChanges([a], [b], t0, { accuracy: { medianKm: 79, p95Km: 808 } }).rows.find((x) => x.kind === 'elements.jump')!;
  assert.deepEqual(withAcc.payload.acc, [79, 808]);
});

test('build-range on 1965 days: SGP objects in the manifest, era accuracy in manifest and jump payloads, era jump threshold', { timeout: 300_000 }, () => {
  const out = join(dir, 'out');
  const r = runBuildRange(['--elsets', files.elsets, '--objects', files.objects, '--out', out, '--from', `${Y}10`, '--to', `${Y}11`, '--workers', '2']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const acc = eraFor(`${Y}10`).accuracy!;
  for (const d of [`${Y}10`, `${Y}11`]) {
    const m = readManifest(join(out, 'coverage'), d)!;
    assert.deepEqual(m.propagators, { sgp: m.norad });
    assert.equal(m.norad.length, 24);
    assert.deepEqual(m.accuracy, acc);
    assert.deepEqual(m.skipped, {});
    const marker = JSON.parse(readFileSync(join(out, 'done', 'changes', '1965', `${d}.json`), 'utf8'));
    assert.equal(marker.sgpObjects, 24);
    assert.equal(marker.jumpDaKm, eraFor(d).jumpDaKm);
  }
  // the manoeuvre of 1003 (set 6 at day 5.4 = 06-10 09:36) is a jump with the era accuracy; the drag of the other objects is not
  const lines = gunzipSync(readFileSync(join(out, 'events', '1965', `${Y}10.jsonl.gz`))).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const jumps = lines.filter((l) => l.kind === 'elements.jump');
  assert.deepEqual(jumps.map((l) => l.subjects[0]), [1003]);
  assert.deepEqual(jumps[0].payload.acc, [acc.medianKm, acc.p95Km]);
});
