// SSA provider (encounter + manoeuvre fields): aggregation, refresh, history-off,
// the registry boot-coverage hint, and an end-to-end /api/query/ask through the
// real provider. The fake-DB blocks always run; the database-backed block runs only
// when DATABASE_URL is set, in a throwaway schema (see tests/ssa/db-helper.ts).

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import type { AnalyticProgram } from '@orbitwatch/analytic';
import { FIELD_REGISTRY } from '@orbitwatch/analytic';
import { DataSourceRegistry } from '../../src/analytic/registry.js';
import { createSsaProvider, SSA_FIELDS, type SsaQueryable } from '../../src/analytic/providers/ssa.js';
import { createQueryRouter } from '../../src/routes/query.js';
import type { AnalyticCompiler, CompileOutcome } from '../../src/services/analytic-compiler.js';
import type { FieldProvider, SpineProvider } from '../../src/analytic/types.js';
import { computeLowBasisFields } from '../../src/eval/hollow.js';
import { createTestDb, DB_URL, type TestDb } from '../ssa/db-helper.js';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ── Fake DB ─────────────────────────────────────────────────────────────────

interface FakeState {
  runId: number | null;
  evMax: number | null;
  evN: number;
  encounterRows: Record<string, unknown>[];
  eventRows: Record<string, unknown>[];
  breakupRows?: Record<string, unknown>[];
  calls: { sig: number; enc: number; ev: number };
  failSignature?: boolean;
}

function fakeDb(state: FakeState): SsaQueryable {
  return {
    async query(sql: string) {
      if (sql.includes('max(id) FROM ssa_run')) {
        state.calls.sig++;
        if (state.failSignature) throw new Error('boom');
        return { rows: [{ run_id: state.runId, ev_max: state.evMax, ev_n: state.evN }] };
      }
      if (sql.includes('FROM conjunction c')) { state.calls.enc++; return { rows: state.encounterRows }; }
      if (sql.includes('FROM ssa_event e')) { state.calls.ev++; return { rows: state.eventRows }; }
      if (sql.includes('FROM ssa_event b')) return { rows: state.breakupRows ?? [] };
      throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
    },
  };
}

function baseState(): FakeState {
  return {
    runId: 7, evMax: 40, evN: 3,
    encounterRows: [
      // 100: three encounters, tcas ascending as the SQL's ORDER BY delivers them
      { norad: 100, n: 3, closest: 0.4, max_pc: 1e-4, tcas: [NOW - 3_600_000, NOW + 3_600_000, NOW + 20 * 3_600_000] },
      { norad: 200, n: 1, closest: 4.2, max_pc: null, tcas: [NOW + 5 * 3_600_000] },
    ],
    eventRows: [
      { norad: 100, kind: 'elements.jump', last_t: new Date(NOW - 2 * DAY), last_da: '3.5',
        recent_times: [NOW - 10 * DAY, NOW - 2 * DAY] },
      { norad: 300, kind: 'elements.jump', last_t: new Date(NOW - 20 * DAY), last_da: '-1.25', recent_times: [NOW - 20 * DAY] },
      { norad: 400, kind: 'object.appeared', last_t: new Date(NOW - 3 * DAY), last_da: null, recent_times: [] },
      { norad: 100, kind: 'close.formation', last_t: new Date(NOW - DAY), last_da: null, recent_times: [] },
      { norad: 200, kind: 'close.formation', last_t: new Date(NOW - 5 * DAY), last_da: null, recent_times: [] },
    ],
    calls: { sig: 0, enc: 0, ev: 0 },
  };
}

function makeProvider(state: FakeState, over: { now?: () => number; db?: boolean; enabled?: boolean } = {}) {
  return createSsaProvider({
    getDb: () => (over.db === false ? null : fakeDb(state)),
    isEnabled: () => over.enabled ?? over.db !== false,
    nowMs: over.now ?? (() => NOW),
    checkIntervalMs: 60_000,
  });
}

describe('ssa provider: aggregation (fake DB)', () => {
  it('declares exactly the nine registry nouns', () => {
    const p = makeProvider(baseState());
    assert.deepEqual([...p.fields].sort(), [...SSA_FIELDS].sort());
    for (const f of p.fields) assert.ok(f in FIELD_REGISTRY, f);
  });

  it('serves per-object encounter and event fields; getField does no I/O', async () => {
    const state = baseState();
    const p = makeProvider(state);
    assert.equal(await p.refresh(), true);
    const callsAfterLoad = { ...state.calls };

    assert.equal(p.getField(100, 'encounterCount36h', NOW), 3);
    assert.equal(p.getField(100, 'closestEncounterKm', NOW), 0.4);
    assert.equal(p.getField(100, 'maxEncounterPc', NOW), 1e-4);
    assert.equal(p.getField(100, 'nextEncounterAt', NOW), iso(NOW + 3_600_000), 'earliest tca >= now, skipping the past one');
    assert.equal(p.getField(100, 'lastManoeuvreAt', NOW), iso(NOW - 2 * DAY));
    assert.equal(p.getField(100, 'lastManoeuvreDeltaAKm', NOW), 3.5);
    assert.equal(p.getField(100, 'manoeuvreCount30d', NOW), 2);
    assert.equal(p.getField(100, 'inFormation', NOW), true);
    assert.equal(p.getField(100, 'appearedAt', NOW), null);

    assert.equal(p.getField(200, 'encounterCount36h', NOW), 1);
    assert.equal(p.getField(200, 'maxEncounterPc', NOW), null);
    assert.equal(p.getField(200, 'inFormation', NOW), false, 'formation 5 days ago is outside the 2-day window');

    assert.equal(p.getField(300, 'lastManoeuvreDeltaAKm', NOW), -1.25, 'signed: lowered orbit');
    assert.equal(p.getField(300, 'manoeuvreCount30d', NOW), 1);
    assert.equal(p.getField(400, 'appearedAt', NOW), iso(NOW - 3 * DAY));

    // many reads, zero extra queries
    for (let i = 0; i < 500; i++) p.getField(100 + (i % 5), 'encounterCount36h', NOW);
    assert.deepEqual(state.calls, callsAfterLoad);
  });

  it('unknown object: count 0, counts 0, booleans false, everything else null', async () => {
    const p = makeProvider(baseState());
    await p.refresh();
    assert.equal(p.getField(999, 'encounterCount36h', NOW), 0);
    assert.equal(p.getField(999, 'manoeuvreCount30d', NOW), 0);
    assert.equal(p.getField(999, 'inFormation', NOW), false);
    for (const f of ['closestEncounterKm', 'maxEncounterPc', 'nextEncounterAt', 'lastManoeuvreAt', 'lastManoeuvreDeltaAKm', 'appearedAt']) {
      assert.equal(p.getField(999, f, NOW), null, f);
    }
    assert.equal(p.getField(100, 'notAField', NOW), null);
  });

  it('time-relative fields follow the bound time, not the load time', async () => {
    const p = makeProvider(baseState());
    await p.refresh();
    assert.equal(p.getField(100, 'nextEncounterAt', NOW + 2 * 3_600_000), iso(NOW + 20 * 3_600_000));
    assert.equal(p.getField(100, 'nextEncounterAt', NOW + 21 * 3_600_000), null);
    assert.equal(p.getField(100, 'manoeuvreCount30d', NOW + 29 * DAY), 0, 'both jumps fell out of the 30-day window');
  });

  it('no screening run yet: encounterCount36h is null (not 0); event fields still work', async () => {
    const state = baseState();
    state.runId = null; state.encounterRows = [];
    const p = makeProvider(state);
    await p.refresh();
    assert.equal(p.getField(100, 'encounterCount36h', NOW), null);
    assert.equal(p.getField(100, 'lastManoeuvreDeltaAKm', NOW), 3.5);
    assert.equal(state.calls.enc, 0, 'no encounter query without a run');
  });

  it('ignores a non-numeric payload.da instead of failing', async () => {
    const state = baseState();
    state.eventRows = [{ norad: 5, kind: 'elements.jump', last_t: new Date(NOW - DAY), last_da: 'n/a', recent_times: [NOW - DAY] }];
    const p = makeProvider(state);
    await p.refresh();
    assert.equal(p.getField(5, 'lastManoeuvreDeltaAKm', NOW), null);
    assert.equal(p.getField(5, 'lastManoeuvreAt', NOW), iso(NOW - DAY));
  });
});

describe('ssa provider: refresh behaviour (fake DB)', () => {
  it('a repeated check with an unchanged signature does not reload', async () => {
    const state = baseState();
    const p = makeProvider(state);
    assert.equal(await p.refresh(), true);
    assert.equal(await p.refresh(), false);
    assert.equal(state.calls.enc, 1);
    assert.equal(state.calls.ev, 1);
    assert.equal(state.calls.sig, 2);
  });

  it('reloads when the latest run id changes', async () => {
    const state = baseState();
    const p = makeProvider(state);
    await p.refresh();
    assert.equal(p.getField(100, 'encounterCount36h', NOW), 3);
    state.runId = 8;
    state.encounterRows = [{ norad: 100, n: 1, closest: 2, max_pc: null, tcas: [NOW + 1000] }];
    assert.equal(await p.refresh(), true);
    assert.equal(p.getField(100, 'encounterCount36h', NOW), 1);
    assert.equal(p.getField(200, 'encounterCount36h', NOW), 0);
    assert.equal(state.calls.enc, 2);
  });

  it('reloads when ssa_event max id or row count changes', async () => {
    const state = baseState();
    const p = makeProvider(state);
    await p.refresh();
    state.evMax = 41; state.evN = 4;
    state.eventRows = [...state.eventRows, { norad: 500, kind: 'elements.jump', last_t: new Date(NOW - 1000), last_da: '0.5', recent_times: [NOW - 1000] }];
    assert.equal(await p.refresh(), true);
    assert.equal(p.getField(500, 'lastManoeuvreDeltaAKm', NOW), 0.5);
    state.evMax = 41; state.evN = 3; // a rewrite that leaves the max id alone still changes the count
    assert.equal(await p.refresh(), true);
  });

  it('reloads when data is older than the max age, even with an unchanged signature', async () => {
    const state = baseState();
    let clock = NOW;
    const p = createSsaProvider({ getDb: () => fakeDb(state), isEnabled: () => true, nowMs: () => clock, maxAgeMs: 3_600_000 });
    await p.refresh();
    clock += 30 * 60_000;
    assert.equal(await p.refresh(), false);
    clock += 31 * 60_000;
    assert.equal(await p.refresh(), true);
  });

  it('the read path schedules a throttled background check and serves null until the first load lands', async () => {
    const state = baseState();
    let clock = NOW;
    const p = createSsaProvider({ getDb: () => fakeDb(state), isEnabled: () => true, nowMs: () => clock, checkIntervalMs: 60_000 });
    assert.equal(p.getField(100, 'encounterCount36h', clock), null, 'not loaded yet');
    await new Promise((r) => setImmediate(r));
    await p.refresh(); // joins the in-flight load
    assert.equal(p.getField(100, 'encounterCount36h', clock), 3);
    const sigAfterLoad = state.calls.sig;
    for (let i = 0; i < 1000; i++) p.getField(100, 'encounterCount36h', clock);
    assert.equal(state.calls.sig, sigAfterLoad, 'throttled: no new checks inside the interval');

    state.runId = 9;
    state.encounterRows = [{ norad: 100, n: 5, closest: 1, max_pc: null, tcas: [1, 2, 3, 4, 5].map((i) => clock + i) }];
    clock += 61_000;
    p.getField(100, 'encounterCount36h', clock); // triggers the check, returns old data immediately
    assert.equal(p.getField(100, 'encounterCount36h', clock), 3);
    await p.refresh();
    assert.equal(p.getField(100, 'encounterCount36h', clock), 5);
  });

  it('a failing check keeps serving the previous data and recovers later', async () => {
    const state = baseState();
    const p = makeProvider(state);
    await p.refresh();
    state.failSignature = true;
    assert.equal(await p.refresh(), false);
    assert.equal(p.getField(100, 'encounterCount36h', NOW), 3);
    state.failSignature = false;
    state.runId = 11;
    assert.equal(await p.refresh(), true);
  });
});

describe('ssa provider: history off', () => {
  it('returns null for every field and never queries', async () => {
    const state = baseState();
    const p = makeProvider(state, { db: false });
    assert.equal(await p.refresh(), false);
    for (const f of SSA_FIELDS) assert.equal(p.getField(100, f, NOW), null, f);
    assert.equal(state.calls.sig, 0);
  });

  it('boot-coverage hint: 1 when history is configured, 0 when not, null for foreign fields', () => {
    const on = makeProvider(baseState());
    const off = makeProvider(baseState(), { db: false, enabled: false });
    for (const f of SSA_FIELDS) { assert.equal(on.coverageHint(f), 1); assert.equal(off.coverageHint(f), 0); }
    assert.equal(on.coverageHint('name'), null);
  });
});

describe('registry: boot coverage with the hint', () => {
  const spine: SpineProvider = { id: 'fixture:spine', spine: () => Array.from({ length: 40_000 }, (_, i) => i + 1) };

  it('does not measure hinted fields per object (no getField calls) and reports the hint', () => {
    let calls = 0;
    const counting: FieldProvider = {
      id: 'fixture:ssa', fields: ['encounterCount36h', 'inFormation'],
      getField: () => { calls++; return null; },
      coverageHint: () => 1,
    };
    const registry = new DataSourceRegistry();
    registry.registerSpine('live', spine);
    registry.register('live', counting);
    const snap = registry.snapshot();
    assert.equal(calls, 0);
    const cov = snap.universes[0]!.fields;
    assert.equal(cov.find((f) => f.field === 'encounterCount36h')!.coverage, 1);
  });

  it('a hint of 0 (history off) flows through as unserved coverage', () => {
    const real = makeProvider(baseState(), { db: false, enabled: false });
    const registry = new DataSourceRegistry();
    registry.registerSpine('live', spine);
    registry.register('live', real);
    const cov = registry.snapshot().universes[0]!.fields;
    assert.ok(cov.every((f) => f.coverage === 0));
    assert.equal(cov.length, SSA_FIELDS.length);
  });
});

describe('hollow detector ignores sparse fields', () => {
  it('a 1% closestEncounterKm basis is not a low-basis gap, a 1% launchMassKg basis still is', () => {
    const low = computeLowBasisFields([
      { field: 'closestEncounterKm', present: 10, total: 1000 },
      { field: 'launchMassKg', present: 10, total: 1000 },
    ]);
    assert.deepEqual(low, ['launchMassKg']);
  });
});

// ── End-to-end through routes/query.ts (LLM mocked) ─────────────────────────

function program(over: Partial<AnalyticProgram>): AnalyticProgram {
  return { v: 1, universe: 'live', timeBinding: { mode: 'now' }, interpretation: 'test', pipeline: [], output: { shape: 'ids' }, ...over } as AnalyticProgram;
}

async function startApp(registry: DataSourceRegistry, outcome: CompileOutcome): Promise<{ url: string; close: () => Promise<void> }> {
  const compiler: AnalyticCompiler = { compile: async () => outcome };
  const app = express();
  app.use(express.json());
  app.use('/api/query', createQueryRouter({ compiler, registry, nowMs: () => NOW }));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/api/query`, close: () => new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))) };
}

const ENCOUNTER_AND_MANOEUVRE: AnalyticProgram = program({
  interpretation: 'encounters in the current run and a manoeuvre in the last 7 days',
  pipeline: [{
    op: 'filter',
    where: {
      op: 'and',
      args: [
        { op: '>', args: [{ field: 'encounterCount36h' }, { lit: 0 }] },
        { op: '>=', args: [{ field: 'lastManoeuvreAt' }, { lit: iso(NOW - 7 * DAY) }] },
      ],
    },
  }],
});

async function ask(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'which satellites have a close approach and manoeuvred this week' }),
  });
  return { status: res.status, json: await res.json() };
}

function registryWith(ssa: FieldProvider, spineIds: number[]): DataSourceRegistry {
  const r = new DataSourceRegistry();
  r.registerSpine('live', { id: 'fixture:spine', spine: () => spineIds });
  r.register('live', ssa);
  return r;
}

describe('POST /api/query/ask with the SSA provider (fake DB, mocked compiler)', () => {
  it('encounterCount36h > 0 AND lastManoeuvreAt within 7 d returns exactly the right noradIds', async () => {
    const state = baseState();
    state.eventRows = [
      { norad: 100, kind: 'elements.jump', last_t: new Date(NOW - 2 * DAY), last_da: '3.5', recent_times: [NOW - 2 * DAY] }, // enc + recent
      { norad: 200, kind: 'elements.jump', last_t: new Date(NOW - 10 * DAY), last_da: '1', recent_times: [NOW - 10 * DAY] }, // enc, jump too old
      { norad: 300, kind: 'elements.jump', last_t: new Date(NOW - 1 * DAY), last_da: '-2', recent_times: [NOW - DAY] }, // recent, no enc
    ];
    const ssa = makeProvider(state);
    await ssa.refresh();
    const registry = registryWith(ssa, [100, 200, 300, 400]);
    const { url, close } = await startApp(registry, { ok: true, program: ENCOUNTER_AND_MANOEUVRE, interpretation: 'x', cached: false, tookMs: 1 });
    try {
      const { status, json } = await ask(url);
      assert.equal(status, 200);
      assert.equal(json.mode, 'result');
      assert.deepEqual(json.result.ids, [100]);
      assert.equal(json.result.meta.scanned, 4);
    } finally { await close(); }
  });

  it('history off: the same program matches nothing (and is logged as hollow, not an error)', async () => {
    const ssa = makeProvider(baseState(), { db: false, enabled: false });
    const registry = registryWith(ssa, [100, 200]);
    const { url, close } = await startApp(registry, { ok: true, program: ENCOUNTER_AND_MANOEUVRE, interpretation: 'x', cached: false, tookMs: 1 });
    try {
      const { json } = await ask(url);
      assert.equal(json.ok, true);
      assert.deepEqual(json.result.ids, []);
    } finally { await close(); }
  });
});

// ── Database-backed: the real SQL against real tables ───────────────────────

describe('ssa provider: database-backed', { skip: !DB_URL && 'DATABASE_URL not set' }, () => {
  let db: TestDb;
  const t = (ms: number) => iso(ms);

  before(async () => {
    db = await createTestDb();
    const { pool } = db;
    await pool.query(`INSERT INTO ssa_run (batch_time, element_cutoff, objects, encounters, duration_s, code_version)
      VALUES ($1,$1,1,1,1,'t'),($2,$2,1,1,1,'t')`, [t(NOW - 30 * 3_600_000), t(NOW - 3_600_000)]);
    const [r1, r2] = (await pool.query(`SELECT id FROM ssa_run ORDER BY id`)).rows.map((r) => Number(r.id)) as [number, number];
    const ins = (a: number, b: number, tca: number, miss: number, pc: number | null, run: number) =>
      pool.query(`INSERT INTO conjunction (norad_a,norad_b,tca,miss_km,vrel_kms,ric_km,volume,pc,pc_max,hbr_km,manoeuvrable,label,first_run,last_run,n_updates)
        VALUES ($1,$2,$3,$4,10,ARRAY[0,0,0],'1x1x1',$5,$5,0.01,false,NULL,$6,$6,1)`, [a, b, t(tca), miss, pc, run]);
    await ins(100, 200, NOW + 2 * 3_600_000, 0.8, 1e-4, r2);
    await ins(100, 300, NOW + 9 * 3_600_000, 3.0, null, r2);
    await ins(100, 400, NOW + 1 * 3_600_000, 40, 1e-9, r2); // wide-box pass: not an encounter
    await ins(200, 500, NOW + 3 * 3_600_000, 0.1, 1e-2, r1); // old run: ignored
    const ev = (kind: string, subjects: number[], endMs: number | null, payload: object) =>
      pool.query(`INSERT INTO ssa_event (day, kind, subjects, t_start, t_end, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
        [t(endMs ?? NOW).slice(0, 10), kind, subjects, t((endMs ?? NOW) - 3600_000), endMs === null ? null : t(endMs), JSON.stringify(payload)]);
    await ev('elements.jump', [100], NOW - 5 * DAY, { da: 2, dir: 'raise' });
    await ev('elements.jump', [100], NOW - 1 * DAY, { da: -0.75, dir: 'lower' });
    await ev('elements.jump', [200], NOW - 60 * DAY, { da: 1 }); // outside the 30-day count, still the latest jump
    await ev('elements.jump', [300], NOW - 2 * DAY, {}); // payload without da
    await ev('object.appeared', [600], NOW - 3 * DAY, { cls: 'new_launch' });
    await ev('close.formation', [700, 701], NOW - 1 * DAY, { frac: 0.9, minKm: 0.2 });
    await ev('close.formation', [800, 801], NOW - 6 * DAY, { frac: 0.9, minKm: 0.2 });
    await ev('object.disappeared', [100], NOW - DAY, { cls: 'decay_likely' }); // other kinds are ignored
  });
  after(async () => { await db?.drop(); });

  function realProvider() {
    return createSsaProvider({ getDb: () => db.pool, isEnabled: () => true, nowMs: () => NOW });
  }

  it('aggregates the current run per object over both sides of the pair', async () => {
    const p = realProvider();
    assert.equal(await p.refresh(), true);
    assert.equal(p.getField(100, 'encounterCount36h', NOW), 2, 'the 40 km box pass is not an encounter');
    assert.equal(p.getField(100, 'closestEncounterKm', NOW), 0.8);
    assert.equal(p.getField(100, 'maxEncounterPc', NOW), 1e-4);
    assert.equal(p.getField(100, 'nextEncounterAt', NOW), t(NOW + 2 * 3_600_000));
    assert.equal(p.getField(200, 'encounterCount36h', NOW), 1);
    assert.equal(p.getField(300, 'closestEncounterKm', NOW), 3);
    assert.equal(p.getField(300, 'maxEncounterPc', NOW), null);
    assert.equal(p.getField(500, 'encounterCount36h', NOW), 0, 'encounter from an older run is not current');
    assert.equal(p.getField(400, 'encounterCount36h', NOW), 0);
  });

  it('aggregates events per object, per kind', async () => {
    const p = realProvider();
    await p.refresh();
    assert.equal(p.getField(100, 'lastManoeuvreAt', NOW), t(NOW - DAY));
    assert.equal(p.getField(100, 'lastManoeuvreDeltaAKm', NOW), -0.75, 'da of the LATEST jump, signed');
    assert.equal(p.getField(100, 'manoeuvreCount30d', NOW), 2);
    assert.equal(p.getField(200, 'lastManoeuvreAt', NOW), t(NOW - 60 * DAY));
    assert.equal(p.getField(200, 'manoeuvreCount30d', NOW), 0);
    assert.equal(p.getField(300, 'lastManoeuvreDeltaAKm', NOW), null);
    assert.equal(p.getField(300, 'manoeuvreCount30d', NOW), 1);
    assert.equal(p.getField(600, 'appearedAt', NOW), t(NOW - 3 * DAY));
    assert.equal(p.getField(700, 'inFormation', NOW), true);
    assert.equal(p.getField(701, 'inFormation', NOW), true);
    assert.equal(p.getField(800, 'inFormation', NOW), false);
    assert.equal(p.getField(100, 'inFormation', NOW), false);
  });

  it('refreshes when a new run lands', async () => {
    const p = realProvider();
    await p.refresh();
    assert.equal(await p.refresh(), false);
    const { pool } = db;
    await pool.query(`INSERT INTO ssa_run (batch_time, element_cutoff, objects, encounters, duration_s, code_version) VALUES ($1,$1,1,1,1,'t')`, [t(NOW)]);
    assert.equal(await p.refresh(), true);
    assert.equal(p.getField(100, 'encounterCount36h', NOW), 0, 'the new run has no encounters yet');
    await pool.query(`DELETE FROM ssa_run WHERE batch_time = $1`, [t(NOW)]);
  });

  it('end to end: encounterCount36h > 0 AND lastManoeuvreAt within 7 d, over real tables', async () => {
    const p = realProvider();
    await p.refresh();
    const registry = registryWith(p, [100, 200, 300, 400, 500, 600]);
    const { url, close } = await startApp(registry, { ok: true, program: ENCOUNTER_AND_MANOEUVRE, interpretation: 'x', cached: false, tookMs: 1 });
    try {
      const { json } = await ask(url);
      assert.deepEqual(json.result.ids, [100, 300]);
    } finally { await close(); }
  });
});


describe('ssa provider: breakup fields (fake DB)', () => {
  const t09 = Date.parse('2009-02-10T00:00:00Z');
  const withBreakups = (): FakeState => ({
    ...baseState(),
    breakupRows: [
      // ascending by time; subjects[0] is the parent
      { at: new Date(t09), subjects: [22675, 33000, 33001], parent: '22675', pieces: '1200' },
      { at: new Date(t09 + 40 * DAY), subjects: [24946, 33001], parent: '24946', pieces: '700' },
    ],
  });

  it('serves breakupAt / breakupPieces / breakupParent: the parent has the piece count, a piece has its parent, the latest fragmentation wins, others read null', async () => {
    const p = makeProvider(withBreakups());
    await p.refresh();
    assert.equal(p.getField(22675, 'breakupAt', NOW), '2009-02-10T00:00:00.000Z');
    assert.equal(p.getField(22675, 'breakupPieces', NOW), 1200);
    assert.equal(p.getField(22675, 'breakupParent', NOW), null);
    assert.equal(p.getField(33000, 'breakupAt', NOW), '2009-02-10T00:00:00.000Z');
    assert.equal(p.getField(33000, 'breakupParent', NOW), 22675);
    assert.equal(p.getField(33000, 'breakupPieces', NOW), null);
    // a piece listed in two fragmentations: the later one
    assert.equal(p.getField(33001, 'breakupParent', NOW), 24946);
    assert.equal(p.getField(33001, 'breakupAt', NOW), new Date(t09 + 40 * DAY).toISOString());
    for (const f of ['breakupAt', 'breakupPieces', 'breakupParent']) assert.equal(p.getField(1, f, NOW), null, f);
  });

  it('the fields are registered, listed by the provider and served by the server only', () => {
    for (const f of ['breakupAt', 'breakupPieces', 'breakupParent']) {
      assert.ok((SSA_FIELDS as readonly string[]).includes(f));
      assert.ok(f in FIELD_REGISTRY, `${f} in FIELD_REGISTRY`);
    }
    assert.equal(FIELD_REGISTRY.breakupAt!.kind, 'date'); assert.equal(FIELD_REGISTRY.breakupPieces!.kind, 'number'); assert.equal(FIELD_REGISTRY.breakupParent!.kind, 'id');
  });

  it('no breakups in the database: every field reads null (not an error)', async () => {
    const p = makeProvider(baseState());
    await p.refresh();
    assert.equal(p.getField(22675, 'breakupAt', NOW), null);
    assert.equal(p.getField(100, 'manoeuvreCount30d', NOW), 2, 'the other fields are unaffected');
  });
});

describe('POST /api/query/ask: "what broke up in 2009" (fake DB, mocked compiler)', () => {
  const BROKE_UP_2009: AnalyticProgram = program({
    universe: 'all',
    interpretation: 'objects that fragmented in 2009, biggest first',
    pipeline: [
      { op: 'filter', where: { op: 'and', args: [
        { op: '>=', args: [{ field: 'breakupAt' }, { lit: '2009-01-01T00:00:00.000Z' }] },
        { op: '<', args: [{ field: 'breakupAt' }, { lit: '2010-01-01T00:00:00.000Z' }] },
        { op: '>=', args: [{ field: 'breakupPieces' }, { lit: 10 }] },
      ] } },
      { op: 'sort', by: 'breakupPieces', dir: 'desc' },
      { op: 'limit', n: 25 },
    ],
    output: { shape: 'table', columns: ['noradId', 'breakupAt', 'breakupPieces'] },
  } as Partial<AnalyticProgram>);

  it('lists the parents of the 2009 fragmentations (not their pieces, not other years), biggest first', async () => {
    const state = baseState();
    state.breakupRows = [
      { at: new Date('2007-01-11T00:00:00Z'), subjects: [25730, 31000], parent: '25730', pieces: '3000' },
      { at: new Date('2009-02-10T00:00:00Z'), subjects: [22675, 33000, 33001], parent: '22675', pieces: '1200' },
      { at: new Date('2009-02-10T00:00:00Z'), subjects: [24946, 34000], parent: '24946', pieces: '600' },
      { at: new Date('2009-06-01T00:00:00Z'), subjects: [41000, 41001], parent: '41000', pieces: '9' },
    ];
    const ssa = makeProvider(state);
    await ssa.refresh();
    const registry = new DataSourceRegistry();
    registry.registerSpine('all', { id: 'fixture:spine', spine: () => [22675, 24946, 25730, 33000, 33001, 34000, 41000, 100] });
    registry.register('all', ssa);
    const { url, close } = await startApp(registry, { ok: true, program: BROKE_UP_2009, interpretation: 'x', cached: false, tookMs: 1 });
    try {
      const { status, json } = await ask(url);
      assert.equal(status, 200, JSON.stringify(json));
      assert.equal(json.mode, 'result');
      assert.deepEqual(json.result.rows.map((r: Record<string, unknown>) => [r.breakupAt, r.breakupPieces]), [['2009-02-10T00:00:00.000Z', 1200], ['2009-02-10T00:00:00.000Z', 600]]);
    } finally { await close(); }
  });
});
