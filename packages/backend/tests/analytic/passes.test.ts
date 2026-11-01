// Perceptor hookup of the ground passes: the passedOver fn through the registry (routing, preparation, memoization), the provider's
// failure modes, and the ask route end to end — a mocked compiler returns a program that uses passedOver; the answer is checked against
// a synthetic coverage set built from a throwaway Postgres schema (skipped without DATABASE_URL) and against fakes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { validateProgram, programNeedsServer, collectProgramRefs, type AnalyticProgram } from '@orbitwatch/analytic';
import { DataSourceRegistry, PrepareError } from '../../src/analytic/registry.js';
import { createPassesProvider, canonical } from '../../src/analytic/providers/passes.js';
import { createQueryRouter } from '../../src/routes/query.js';
import type { AnalyticCompiler, CompileOutcome } from '../../src/services/analytic-compiler.js';
import type { FieldProvider, SpineProvider } from '../../src/analytic/types.js';
import { circleRegion, resolveRegion, GUARANTEE } from '../../src/ssa/passes/index.js';
import { makeFixture, truthFor, dayMs, DAY_MS } from '../ssa/passes-fixture.js';
import { DB_URL } from '../ssa/db-helper.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const SPINE: SpineProvider = { id: 'fixture:spine', spine: () => [100, 101, 102, 103, 104, 105] };
const programProvider: FieldProvider = { id: 'fixture:program', fields: ['program'], getField: (n, f) => (f === 'program' ? (n % 2 === 0 ? 'starlink' : 'other') : null) };
const inIndia = (over: Record<string, unknown> = {}) => ({ fn: 'passedOver', region: 'india', from: '2026-10-01T12:00:00.000Z', to: '2026-10-14T00:00:00.000Z', ...over });
const prog = (where: unknown, over: Record<string, unknown> = {}): AnalyticProgram => {
  const v = validateProgram({ v: 1, universe: 'live', timeBinding: { mode: 'now' }, interpretation: 'test', pipeline: [{ op: 'filter', where }], output: { shape: 'ids' }, ...over }, { nowMs: NOW });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return v.program;
};

function registryWith(passes: FieldProvider): DataSourceRegistry {
  const r = new DataSourceRegistry();
  r.registerSpine('live', SPINE);
  r.register('live', programProvider);
  r.register('live', passes);
  r.registerSpine('all', SPINE);
  r.register('all', programProvider);
  r.register('all', passes);
  return r;
}

type SetFn = NonNullable<Parameters<typeof createPassesProvider>[0]['passedOverSet']>;
const fakeSet = (ids: number[], calls: Array<{ region: string; from: number; to: number }> = [], extra: { missingDays?: string[]; delayMs?: number } = {}): SetFn =>
  async (_p, region, from, to) => {
    calls.push({ region: region.id, from, to });
    if (extra.delayMs) await new Promise((r) => setTimeout(r, extra.delayMs));
    return { ids: new Set(ids), missingDays: extra.missingDays ?? [], clippedToNow: false };
  };
const fakeDb = {} as Pool;

describe('passedOver — registry routing and provider memoization', () => {
  it('registration needs the method; the fn is owned by the passes provider; the source answers from the memo', async () => {
    assert.throws(() => registryWith({ id: 'bad', fields: [], fns: ['passedOver'], getField: () => null }), /no matching method/);
    const calls: Array<{ region: string; from: number; to: number }> = [];
    const provider = createPassesProvider({ getDb: () => fakeDb, passedOverSet: fakeSet([101, 103], calls), nowMs: () => NOW });
    const registry = registryWith(provider);
    const p = prog(inIndia());
    assert.equal(programNeedsServer(p), true);
    assert.ok(collectProgramRefs(p).fns.has('passedOver'));
    const src = registry.buildSource('live')!;
    const spec = collectProgramRefs(p).fnExprs[0]! as Parameters<NonNullable<typeof src.passedOver>>[1];
    // before preparation nothing is known: null, never "everyone"
    assert.equal(src.passedOver!(1, spec, NOW), null);
    const notes = await registry.prepare(p, NOW);
    assert.deepEqual(notes, [GUARANTEE]);
    assert.deepEqual([100, 101, 102, 103, 104, 105].map((n, i) => src.passedOver!(i, spec, NOW)), [false, true, false, true, false, false]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.region, 'india');
    assert.equal(calls[0]!.from, Date.parse('2026-10-01T12:00:00Z'));
  });

  it('the pass query runs ONCE per program evaluation: repeated and concurrent preparations share it; a different spec is a different run', async () => {
    const calls: Array<{ region: string; from: number; to: number }> = [];
    const provider = createPassesProvider({ getDb: () => fakeDb, passedOverSet: fakeSet([100], calls, { delayMs: 30 }), nowMs: () => NOW });
    const registry = registryWith(provider);
    const p = prog({ op: 'and', args: [inIndia(), inIndia(), { op: 'not', arg: inIndia() }] }); // three references, one spec
    await Promise.all([registry.prepare(p, NOW), registry.prepare(p, NOW), registry.prepare(prog(inIndia()), NOW)]);
    assert.equal(calls.length, 1);
    await registry.prepare(prog(inIndia()), NOW);
    assert.equal(calls.length, 1);
    assert.equal(provider.memoSize(), 1);
    await registry.prepare(prog(inIndia({ region: { latDeg: 48.85, lonDeg: 2.35, radiusKm: 500 } })), NOW);
    await registry.prepare(prog(inIndia({ region: 'japan' })), NOW);
    assert.equal(calls.length, 3);
    assert.equal(calls[1]!.region, 'circle:48.85,2.35,500');
  });

  it('notes: approximate outline, days without coverage, a window cut at now; entirely future windows are empty', async () => {
    const provider = createPassesProvider({ getDb: () => fakeDb, passedOverSet: fakeSet([100], [], { missingDays: ['2026-10-05', '2026-10-06'] }), nowMs: () => NOW });
    const registry = registryWith(provider);
    const notes = await registry.prepare(prog(inIndia({ region: 'japan', to: '2026-10-20T00:00:00.000Z' })), NOW);
    assert.equal(notes.length, 4, notes.join(' | '));
    assert.equal(notes[0], GUARANTEE);
    assert.match(notes.join(' '), /cut at the current time/);
    assert.match(notes.join(' '), /No coverage data for 2 day\(s\).*2026-10-05, 2026-10-06/);
    assert.match(notes.join(' '), /Japan outline is approximate/);
    const future = await registry.prepare(prog(inIndia({ from: '2026-10-20T00:00:00.000Z', to: '2026-10-21T00:00:00.000Z' })), NOW);
    assert.match(future[0]!, /entirely in the future/);
  });

  it('memo lifetime: a settled past window is kept for a day, a window up to now for ten minutes', async () => {
    let now = NOW;
    const calls: unknown[] = [];
    const provider = createPassesProvider({ getDb: () => fakeDb, passedOverSet: fakeSet([100], calls as never), nowMs: () => now });
    const registry = registryWith(provider);
    const past = prog(inIndia({ to: '2026-10-13T00:00:00.000Z' })), live = prog(inIndia({ to: '2026-10-14T11:59:00.000Z' }));
    await registry.prepare(past, now); await registry.prepare(live, now);
    assert.equal(calls.length, 2);
    now = NOW + 11 * 60_000;
    await registry.prepare(past, now); await registry.prepare(live, now);
    assert.equal(calls.length, 3); // only the live-window one was recomputed
    now = NOW + 25 * 3_600_000;
    await registry.prepare(past, now);
    assert.equal(calls.length, 4); // after a day the settled one is recomputed too
  });

  it('failures: no database -> PrepareError (the ask route answers E-UNAVAILABLE); other fns/universes unaffected', async () => {
    const provider = createPassesProvider({ getDb: () => null, nowMs: () => NOW });
    const registry = registryWith(provider);
    await assert.rejects(registry.prepare(prog(inIndia()), NOW), (e: unknown) => e instanceof PrepareError && /history database/.test((e as Error).message));
    assert.deepEqual(await registry.prepare(prog({ op: 'in', field: 'program', values: ['starlink'] }), NOW), []);
    // a registry with no passes provider at all
    const bare = new DataSourceRegistry(); bare.registerSpine('live', SPINE); bare.register('live', programProvider);
    await assert.rejects(bare.prepare(prog(inIndia()), NOW), PrepareError);
  });

  it('canonical window: whole minutes, cut at now', () => {
    const c = canonical({ fn: 'passedOver', region: 'india', from: '2026-10-01T12:00:30.500Z', to: '2026-10-20T00:00:00Z' }, NOW);
    assert.equal(c.fromMs, Date.parse('2026-10-01T12:00:00Z'));
    assert.equal(c.toMs, Date.parse('2026-10-14T12:00:00Z'));
    assert.equal(c.clipped, true);
    assert.throws(() => canonical({ fn: 'passedOver', region: 'atlantis', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }, NOW), /unknown region/);
  });
});

// ── ask route ─────────────────────────────────────────────────────────────────
function fakeCompiler(p: AnalyticProgram): AnalyticCompiler {
  const outcome: CompileOutcome = { ok: true, program: p, interpretation: p.interpretation, cached: false, tookMs: 1 };
  return { compile: async () => outcome };
}
async function startApp(deps: Parameters<typeof createQueryRouter>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express(); app.use(express.json()); app.use('/api/query', createQueryRouter(deps));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/api/query`, close: () => new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))) };
}
const ask = async (url: string) => {
  const r = await fetch(`${url}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'who passed over India in the last 30 days', tMs: NOW }) });
  return { status: r.status, json: (await r.json()) as any };
};

describe('POST /api/query/ask with passedOver (mocked compiler)', () => {
  it('returns the ids of the objects in the pass set, combined with another filter, and the notes of the preparation', async () => {
    const provider = createPassesProvider({ getDb: () => fakeDb, passedOverSet: fakeSet([100, 101, 103, 104], [], { missingDays: ['2026-10-02'] }), nowMs: () => NOW });
    const p = prog({ op: 'and', args: [{ op: 'in', field: 'program', values: ['starlink'] }, inIndia({ to: '2026-10-13T00:00:00.000Z' })] });
    const { url, close } = await startApp({ compiler: fakeCompiler(p), registry: registryWith(provider), nowMs: () => NOW });
    try {
      const { status, json } = await ask(url);
      assert.equal(status, 200); assert.equal(json.ok, true); assert.equal(json.mode, 'result');
      assert.deepEqual(json.result.ids, [100, 104]); // starlink = even norad ids, and in the pass set
      assert.match(json.notes.join(' '), /No coverage data for 1 day/);
      assert.equal(json.notes[0], GUARANTEE);
    } finally { await close(); }
  });

  it('without the history database the answer is a clean runtime error, not an empty result', async () => {
    const provider = createPassesProvider({ getDb: () => null });
    const { url, close } = await startApp({ compiler: fakeCompiler(prog(inIndia())), registry: registryWith(provider), nowMs: () => NOW });
    try {
      const { status, json } = await ask(url);
      assert.equal(status, 200); assert.equal(json.ok, false);
      assert.equal(json.runtime.code, 'E-UNAVAILABLE');
    } finally { await close(); }
  });
});

describe('POST /api/query/ask with passedOver (synthetic coverage set, real pass query)', { skip: DB_URL ? false : 'DATABASE_URL not set' }, () => {
  it('"who passed over India / a Paris circle": the ids equal a brute-force sweep of the same days', { timeout: 600_000 }, async () => {
    const days = ['2026-10-10', '2026-10-11'];
    const fx = await makeFixture(days, days, 40);
    try {
      const ids = [...Array.from({ length: 40 }, (_, i) => 100 + i), 5000];
      const spine: SpineProvider = { id: 'fixture:spine', spine: () => ids };
      const provider = createPassesProvider({ getDb: () => fx.pool, opts: { dir: fx.dir, workers: 2 } });
      const reg = new DataSourceRegistry();
      reg.registerSpine('live', spine); reg.register('live', programProvider); reg.register('live', provider);
      const from = dayMs('2026-10-10'), to = dayMs('2026-10-12');
      // today = the 14th in this test: the window is a past, settled one
      for (const [region, spec] of [[resolveRegion('india'), 'india'], [circleRegion(30, 20, 3000), { latDeg: 30, lonDeg: 20, radiusKm: 3000 }]] as const) {
        const truth = await truthFor(fx.pool, region, days, from, to);
        assert.ok(truth.refined.size > 3, `fixture should have passes over ${region.id}`);
        const p = prog(inIndia({ region: spec, from: new Date(from).toISOString(), to: new Date(to).toISOString() }));
        const { url, close } = await startApp({ compiler: fakeCompiler(p), registry: reg, nowMs: () => NOW });
        try {
          const { json } = await ask(url);
          assert.equal(json.ok, true, JSON.stringify(json));
          const got = new Set<number>(json.result.ids);
          for (const id of truth.sampled) assert.ok(got.has(id), `${region.id}: ${id} missing`);
          assert.deepEqual([...got].sort((a, b) => a - b), [...truth.refined].sort((a, b) => a - b));
        } finally { await close(); }
      }
      void DAY_MS;
    } finally { await fx.cleanup(); }
  });
});
