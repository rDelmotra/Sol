// Parity of the production change detection (src/ssa/events) with the frozen spike (scripts/starmap/derive-day.ts, events.ts) on two
// consecutive replay days. Needs the replay data (data/history catalogs, data/events/{events-stats.jsonl,firstseen.json,
// verify-formation.txt}), which is not in git; skipped when it is absent.
//   SSA_CHANGES_PARITY_DAYS   comma list of days to replay (default 2026-10-12,2026-10-13; the day before each must exist too)
//   SSA_CHANGES_SPIKE_DUMP    dir holding spike-DAY.json (derive-day.ts --only diff,ca --dry --dump): when present every spike row of
//                             the four kinds is compared with the port's (subjects, times, payload)
//
// Reference for the diff part: the spike's own jumpMetrics() on the same catalogs, and the per-day counts and class histograms the
// spike recorded (events-stats.jsonl). Reference for formation: the recorded count and the stored pairs listed in verify-formation.txt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { deriveChanges } from '../../src/ssa/events/changes.js';
import { deriveFormations } from '../../src/ssa/events/formation.js';
import type { ChangeObject, EventRow } from '../../src/ssa/events/types.js';

const HIST = new URL('../../data/history/', import.meta.url).pathname;
const EVENTS = new URL('../../data/events/', import.meta.url).pathname;
const DAYS = (process.env.SSA_CHANGES_PARITY_DAYS ?? '2026-10-12,2026-10-13').split(',');
const DUMP = process.env.SSA_CHANGES_SPIKE_DUMP;
const prevDay = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
const need = [`${EVENTS}events-stats.jsonl`, `${EVENTS}firstseen.json`, `${EVENTS}verify-formation.txt`, ...DAYS.flatMap((d) => [`${HIST}catalog-${d}.json`, `${HIST}catalog-${prevDay(d)}.json`])];
const missing = need.filter((f) => !existsSync(f));

interface FileObj { noradId: number; name: string; regime: string; launchDate?: string; perigee?: number; apogee?: number; omm: Record<string, unknown> }
const load = (day: string): ChangeObject[] => (JSON.parse(readFileSync(`${HIST}catalog-${day}.json`, 'utf8')) as FileObj[]).map((o) => ({
  noradId: o.noradId, name: o.name, regime: o.regime, perigee: o.perigee, apogee: o.apogee, launchDate: o.launchDate ?? null, omm: o.omm,
}));
const histogram = (rows: EventRow[], kind: string) => rows.filter((r) => r.kind === kind).reduce<Record<string, number>>((m, r) => { const c = String(r.payload.cls ?? r.payload.dir); m[c] = (m[c] ?? 0) + 1; return m; }, {});

function near(a: unknown, b: unknown, path: string): void {
  if (typeof a === 'number' && typeof b === 'number') { assert.ok(Math.abs(a - b) <= 1e-6, `${path}: ${a} vs ${b}`); return; }
  assert.deepEqual(a ?? null, b ?? null, path);
}

for (const day of DAYS) {
  test(`change detection parity with the spike: ${day}`, { skip: missing.length ? `replay data not present (${missing[0]})` : false, timeout: 1_800_000 }, async () => {
    const { jumpMetrics } = await import('../../scripts/starmap/events.js');
    const prev = load(prevDay(day)), cur = load(day);
    const t0 = Date.parse(day + 'T00:00:00Z');
    const firstSeen = new Map(Object.entries(JSON.parse(readFileSync(`${EVENTS}firstseen.json`, 'utf8')) as Record<string, string>).map(([k, v]) => [Number(k), v]));
    const stats = readFileSync(`${EVENTS}events-stats.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { day: string; diff?: Record<string, unknown>; rows?: Record<string, number> }).filter((s) => s.day === day && s.diff).pop()!;

    const T = Date.now();
    const { rows, stats: mine } = deriveChanges(prev, cur, t0, { firstSeen: (id) => firstSeen.get(id) });
    const wallDiff = (Date.now() - T) / 1000;
    const T2 = Date.now();
    const form = deriveFormations(cur, t0);
    const wallForm = (Date.now() - T2) / 1000;
    const ref = stats.diff as { appeared: number; disappeared: number; jumps: number; changedElsets: number; appClass: Record<string, number>; disClass: Record<string, number>; jumpDir: Record<string, number> };
    console.log(`changes parity ${day}: appeared ${mine.appeared}/${ref.appeared}, disappeared ${mine.disappeared}/${ref.disappeared}, jumps ${mine.jumps}/${ref.jumps}, changed sets ${mine.changedElsets}/${ref.changedElsets}, formation ${form.rows.length}/${stats.rows!['close.formation']} (diff ${wallDiff.toFixed(1)} s, formation ${wallForm.toFixed(1)} s, ${form.stats.candidatePairs} candidate pairs, ${form.stats.fenced} fenced)`);

    // counts and classes as the spike recorded them
    assert.deepEqual([mine.appeared, mine.disappeared, mine.jumps, mine.changedElsets], [ref.appeared, ref.disappeared, ref.jumps, ref.changedElsets]);
    assert.deepEqual(mine.appClass, ref.appClass);
    assert.deepEqual(mine.disClass, ref.disClass);
    assert.deepEqual(mine.jumpDir, ref.jumpDir);

    // every jump row against the spike's own metrics: same objects, same rounded payload numbers, same interval
    const spikeJumps = jumpMetrics(prev as never, cur as never).metrics.filter((m: { dposKm: number; daKm: number; residKm: number }) => m.dposKm > 16.3 && Math.abs(m.daKm) > 1 && Math.abs(m.residKm) > 1);
    const mineJumps = rows.filter((r) => r.kind === 'elements.jump');
    assert.equal(mineJumps.length, spikeJumps.length);
    const byId = new Map(mineJumps.map((r) => [r.subjects[0]!, r]));
    let maxDelta = 0;
    for (const m of spikeJumps as Array<{ norad: number; dposKm: number; daKm: number; residKm: number; dIncDeg: number; dAlong: number; gapDays: number; prevEpochMs: number; newEpochMs: number; regime: string; name: string }>) {
      const r = byId.get(m.norad)!;
      assert.ok(r, `jump of ${m.norad} missing`);
      const want = { dpos: +m.dposKm.toFixed(2), da: +m.daKm.toFixed(3), resid: +m.residKm.toFixed(3), dinc: +m.dIncDeg.toFixed(4), along: +m.dAlong.toFixed(2), gap: +m.gapDays.toFixed(2), dir: m.daKm > 0 ? 'raise' : 'lower', reg: m.regime, name: m.name };
      for (const [k, v] of Object.entries(want)) { near(r.payload[k], v, `${m.norad}.${k}`); if (typeof v === 'number') maxDelta = Math.max(maxDelta, Math.abs((r.payload[k] as number) - v)); }
      assert.equal(r.tStart, m.prevEpochMs);
      assert.equal(r.tEnd, m.newEpochMs);
    }
    console.log(`  jump payload numbers: max |difference| ${maxDelta}`);

    // formation: the recorded count, and the stored pairs the spike's own verification listed for this day
    assert.equal(form.rows.length, stats.rows!['close.formation']);
    const listed = readFileSync(`${EVENTS}verify-formation.txt`, 'utf8').split('\n').map((l) => /^formation (\d+)-(\d+) (\d{4}-\d{2}-\d{2}) .*stored frac ([\d.]+) min ([\d.]+) km/.exec(l)).filter((m): m is RegExpExecArray => !!m && m[3] === day);
    const fm = new Map(form.rows.map((r) => [r.subjects.join('-'), r]));
    for (const m of listed) {
      const r = fm.get(`${m[1]}-${m[2]}`);
      assert.ok(r, `formation ${m[1]}-${m[2]} missing`);
      assert.ok(Math.abs((r.payload.frac as number) - Number(m[4])) < 1e-3 && Math.abs((r.payload.minKm as number) - Number(m[5])) < 1e-3, `${m[1]}-${m[2]}: ${JSON.stringify(r.payload)} vs ${m[4]}/${m[5]}`);
    }
    console.log(`  formation: ${listed.length} listed pairs found with the stored frac / minKm`);

    // optional: every row of a full spike dump
    const dump = DUMP && existsSync(`${DUMP}/spike-${day}.json`) ? (JSON.parse(readFileSync(`${DUMP}/spike-${day}.json`, 'utf8')) as Array<{ kind: string; subjects: number[]; tStart: number; tEnd: number; payload: Record<string, unknown> }>) : null;
    if (dump) {
      const kinds = ['object.appeared', 'object.disappeared', 'elements.jump', 'close.formation'];
      const mineAll = [...rows, ...form.rows];
      const dropped = new Set(['satcat', 'live']);
      let nCompared = 0;
      for (const kind of kinds) {
        const a: typeof dump = dump.filter((r) => r.kind === kind);
        const b = mineAll.filter((r) => r.kind === kind);
        assert.equal(b.length, a.length, `${kind}: ${b.length} vs ${a.length}`);
        const key = (r: { subjects: number[] }) => r.subjects.join('-');
        const bm = new Map(b.map((r) => [key(r), r]));
        for (const x of a) {
          const y = bm.get(key(x))!;
          assert.ok(y, `${kind} ${key(x)} missing`);
          assert.ok(Math.abs(x.tStart - y.tStart) < 1 && Math.abs(x.tEnd - y.tEnd) < 1, `${kind} ${key(x)} times`);
          for (const [k, v] of Object.entries(x.payload)) if (!dropped.has(k)) near(y.payload[k], v, `${kind} ${key(x)}.${k}`);
          for (const k of Object.keys(y.payload)) assert.ok(k in x.payload || y.payload[k] === undefined, `${kind}: extra payload field ${k}`);
          nCompared++;
        }
      }
      console.log(`  full spike dump: ${nCompared} rows compared (payload numbers within 1e-6; dropped fields satcat, live)`);
    }
  });
}
